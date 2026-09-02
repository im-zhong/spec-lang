/**
 * Durable GitHub execution for the compiler-owned generation DAG.
 *
 * This is not a second development graph. Every node below is the original
 * generator task, given a disposable worktree/container and a durable
 * branch/commit/PR result. Dependency edges carry only published head SHAs.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type {
  AgentExecutionEnvironment,
  AgentExecutionMergePolicy,
  AgentExecutionPlan,
  AgentExecutionTask,
} from "@spec/core"
import {
  createAgentExecutionPlan,
  DockerAgentExecutor,
  GitAgentExecutionRepository,
  GitHubCliAdapter,
  runAgentExecutionPlan,
  type AgentExecutionReport,
} from "@spec/execution"
import { buildClaudeArgs } from "./runner"
import type { ShotSpec } from "./orchestrate"

export interface CompilerMaterialization {
  id: string
  objective: string
  files: Record<string, string>
  commands: string[]
  specNodeIds?: string[]
}

export interface GitHubGenerationPlanInput {
  shot: ShotSpec
  runId: string
  repository: string
  rootBaseSha: string
  targetDirectory: string
  environment: AgentExecutionEnvironment
  requiredChecks: string[]
  mergePolicy?: AgentExecutionMergePolicy
  finalMaterializations?: CompilerMaterialization[]
}

export interface GitHubGenerationRunOptions {
  repoRoot: string
  worktreeRoot?: string
  concurrency?: number
  resume?: boolean
  model?: string
  maxTurns?: number
  onTaskStart?: (taskId: string) => void
  onTaskEnd?: (taskId: string, ok: boolean, headSha?: string) => void
}

function safeTaskId(id: string): string {
  const value = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  if (!value) throw new Error(`generation task id cannot form a Git ref segment: ${id}`)
  return value
}

function targetDirectory(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")
  if (!normalized || !/^[A-Za-z0-9._/-]+$/.test(normalized) || path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("generation targetDirectory must be a safe repository-relative path")
  }
  return normalized
}

function inTarget(root: string, relative: string): string {
  const normalized = relative.replaceAll("\\", "/")
  if (path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => part === "..")) {
    throw new Error(`generation output escapes its target directory: ${relative}`)
  }
  return path.posix.join(root, normalized)
}

/** Convert one compiler-owned shot DAG without changing any of its edges. */
export function createGitHubGenerationPlan(input: GitHubGenerationPlanInput): AgentExecutionPlan {
  const directory = targetDirectory(input.targetDirectory)
  const ids = new Map(input.shot.tasks.map((task) => [task.id, safeTaskId(task.id)]))
  if (new Set(ids.values()).size !== ids.size) throw new Error("generation task ids collide after Git ref normalization")
  const reserved = new Set(["compiler-seed", "conformance", ...(input.finalMaterializations ?? []).map((item) => safeTaskId(item.id))])
  const collision = [...ids.values()].find((id) => reserved.has(id))
  if (collision) throw new Error(`generation task id collides with compiler execution node: ${collision}`)
  if (reserved.size !== 2 + (input.finalMaterializations?.length ?? 0)) {
    throw new Error("compiler materialization ids must be unique")
  }

  const tasks: AgentExecutionTask[] = []
  const seedFiles = input.shot.seedFiles ?? {}
  const hasSeed = Object.keys(seedFiles).length > 0
  if (hasSeed) {
    tasks.push({
      id: "compiler-seed",
      objective: "materialize compiler-owned generation inputs",
      instruction: "Materialize compiler-owned seed files exactly.",
      executor: "materialize",
      materializedFiles: seedFiles,
      dependsOn: [],
      workingDirectory: directory,
      scope: Object.keys(seedFiles).map((file) => inTarget(directory, file)).sort(),
      specNodeIds: [],
      acceptance: { requiredChecks: input.requiredChecks, commands: ["true"] },
    })
  }

  for (const task of input.shot.tasks) {
    tasks.push({
      id: ids.get(task.id)!,
      objective: task.label ?? task.id,
      instruction: task.prompt,
      executor: "agent",
      dependsOn: task.dependsOn.length > 0
        ? task.dependsOn.map((dependency) => ids.get(dependency)!).sort()
        : hasSeed ? ["compiler-seed"] : [],
      workingDirectory: directory,
      scope: task.scope.map((file) => inTarget(directory, file)).sort(),
      specNodeIds: [...(task.specNodeIds ?? [])].sort(),
      acceptance: { requiredChecks: input.requiredChecks, commands: ["true"] },
    })
  }

  const generationSinks = input.shot.tasks
    .filter((candidate) => !input.shot.tasks.some((task) => task.dependsOn.includes(candidate.id)))
    .map((task) => ids.get(task.id)!)
    .sort()
  tasks.push({
    id: "conformance",
    objective: "materialize and run the compiler-owned conformance oracle",
    instruction: "Materialize the oracle exactly and verify once. Never repair generated code after conformance.",
    executor: "materialize",
    materializedFiles: input.shot.conformanceFiles,
    dependsOn: generationSinks,
    workingDirectory: directory,
    scope: [...Object.keys(input.shot.conformanceFiles), ...(input.shot.evidenceFiles ?? [])]
      .map((file) => inTarget(directory, file)).sort(),
    specNodeIds: [...new Set(input.shot.tasks.flatMap((task) => task.specNodeIds ?? []))].sort(),
    acceptance: {
      requiredChecks: input.requiredChecks,
      commands: [
        ...input.shot.verification.setup.map((command) => command.command),
        ...input.shot.verification.check.map((command) => command.command),
        ...(input.shot.evidenceCommands ?? []).map((command) => command.command),
      ],
    },
  })

  let parent = "conformance"
  for (const materialization of input.finalMaterializations ?? []) {
    const id = safeTaskId(materialization.id)
    tasks.push({
      id,
      objective: materialization.objective,
      instruction: `Materialize compiler-owned ${materialization.id} files exactly.`,
      executor: "materialize",
      materializedFiles: materialization.files,
      dependsOn: [parent],
      workingDirectory: directory,
      scope: Object.keys(materialization.files).map((file) => inTarget(directory, file)).sort(),
      specNodeIds: [...(materialization.specNodeIds ?? [])].sort(),
      acceptance: { requiredChecks: input.requiredChecks, commands: [...materialization.commands] },
    })
    parent = id
  }

  return createAgentExecutionPlan({
    runId: input.runId,
    repository: input.repository,
    rootBaseSha: input.rootBaseSha,
    branchPrefix: "spec/generate",
    environment: input.environment,
    acceptance: { requiredChecks: input.requiredChecks, commands: ["true"] },
    mergePolicy: input.mergePolicy ?? "pull-request",
    tasks,
  })
}

/** Run original generator nodes through disposable containers and GitHub PRs. */
export async function runGitHubGeneration(
  plan: AgentExecutionPlan,
  options: GitHubGenerationRunOptions,
): Promise<AgentExecutionReport> {
  const repoRoot = path.resolve(options.repoRoot)
  const worktreeRoot = options.worktreeRoot
    ? path.resolve(options.worktreeRoot)
    : path.join(path.dirname(repoRoot), ".spec-worktrees", path.basename(repoRoot))
  const mounts = []
  const claudeDirectory = path.join(os.homedir(), ".claude")
  if (fs.existsSync(claudeDirectory)) mounts.push({ source: claudeDirectory, target: "/opt/spec-host-claude", readOnly: true })
  const claudeConfig = path.join(os.homedir(), ".claude.json")
  if (fs.existsSync(claudeConfig)) mounts.push({ source: claudeConfig, target: "/opt/spec-host-claude.json", readOnly: true })
  const environmentVariables = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]
    .filter((name) => process.env[name] !== undefined)
  const bootstrap = [
    "set -eu",
    "mkdir -p /home/node/.claude",
    "if [ -d /opt/spec-host-claude ]; then cp -R /opt/spec-host-claude/. /home/node/.claude/; fi",
    "if [ -f /opt/spec-host-claude.json ]; then cp /opt/spec-host-claude.json /home/node/.claude.json; fi",
    'exec claude "$@"',
  ].join("; ")
  const agentCommand = ["/bin/sh", "-lc", bootstrap, "spec-agent", ...buildClaudeArgs({ model: options.model, maxTurns: options.maxTurns })]

  return runAgentExecutionPlan(plan, {
    repository: new GitAgentExecutionRepository({ repoRoot, worktreeRoot }),
    containers: new DockerAgentExecutor({
      mounts,
      environmentVariables,
      agentCommand,
    }),
    github: new GitHubCliAdapter({ cwd: repoRoot }),
    concurrency: options.concurrency,
    resume: options.resume,
    onTaskStart: (task) => options.onTaskStart?.(task.id),
    onTaskEnd: (result) => options.onTaskEnd?.(result.taskId, result.status !== "failure", result.headSha),
  })
}
