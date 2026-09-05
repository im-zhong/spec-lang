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
import { openEventLog } from "@spec/execution"
import {
  createAgentExecutionPlan,
  DockerAgentExecutor,
  GitAgentExecutionRepository,
  GitHubCliAdapter,
  HostAgentExecutor,
  LocalGitControlPlane,
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
  defaultBranch?: string
  rootBaseSha: string
  targetDirectory: string
  environment: AgentExecutionEnvironment
  requiredChecks: string[]
  mergePolicy?: AgentExecutionMergePolicy
  finalMaterializations?: CompilerMaterialization[]
  /** Retry from a failed node: keep landed predecessors, re-run from here down. */
  retryFrom?: string
  /** Plan version for immutable-ref versioning (auto: retryFrom ⇒ ≥2). */
  planVersion?: number
}

export interface GitHubGenerationRunOptions {
  repoRoot: string
  worktreeRoot?: string
  concurrency?: number
  resume?: boolean
  model?: string
  effort: "low" | "medium" | "high" | "xhigh" | "max"
  maxTurns: number
  /** Where the agent and acceptance commands execute: a pinned container (default) or directly on this host. */
  runtime?: "docker" | "host"
  /** Durable-branch control plane: real GitHub PRs/checks (default) or a plain local Git remote. */
  execution?: "github" | "local"
  onTaskStart?: (taskId: string) => void
  onTaskEnd?: (taskId: string, ok: boolean, headSha?: string) => void
  /** Run root for the telemetry event log (`<runRoot>/events/`); omit to disable. */
  eventsRoot?: string
  /** Telemetry identity: the run id and shot label stamped onto every event. */
  runId?: string
  shot?: string
  /** Retry from a failed node: reuse landed heads, re-run from here down. */
  retryFrom?: string
  /** Plan version for immutable-ref versioning (≥2 on retry). */
  planVersion?: number
  /** Separate model for the reviewer role (defaults to --model). */
  reviewerModel?: string
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

  // Retry-from: re-run every task that did NOT land cleanly plus their
  // transitive descendants. Landed predecessors become no-op pass-throughs.
  let activeTasks = input.shot.tasks
  if (input.retryFrom !== undefined) {
    // Seed with the retry target AND every task that shares a dependency
    // level with it and also depends on the same set of prerequisites —
    // siblings that failed alongside it (e.g. router:User + router:Booking)
    // must re-run too. More precisely: seed with ALL tasks whose dependency
    // closure is NOT a strict subset of the landed set (i.e. any task that
    // could not have completed before the retry target started failing).
    const retryId = safeTaskId(input.retryFrom)
    const descendants = new Set<string>([retryId])
    // True siblings: share a direct dependency with the retry target BUT
    // are NOT in its transitive dependency closure (schemas/security are
    // dependencies of the routers, not siblings — they must pass through).
    const retryDeps = input.shot.tasks
        .find((t) => safeTaskId(t.id) === retryId)?.dependsOn.map(safeTaskId) ?? []
    // Compute the retry target's full dependency closure
    const depClosure = new Set<string>()
    const growClosure = (id: string) => {
      if (depClosure.has(id)) return
      depClosure.add(id)
      const deps = input.shot.tasks.find((t) => safeTaskId(t.id) === id)?.dependsOn.map(safeTaskId) ?? []
      deps.forEach(growClosure)
    }
    growClosure(retryId)
    for (const task of input.shot.tasks) {
      const normalized = safeTaskId(task.id)
      if (descendants.has(normalized)) continue
      if (depClosure.has(normalized)) continue // it's a dependency, not a sibling
      if (task.dependsOn.map(safeTaskId).some((dep) => retryDeps.includes(dep))) {
        descendants.add(normalized)
      }
    }
    // Transitive closure downward
    let grew = true
    while (grew) {
      grew = false
      for (const task of input.shot.tasks) {
        const normalized = safeTaskId(task.id)
        if (descendants.has(normalized)) continue
        if (task.dependsOn.some((dep) => descendants.has(safeTaskId(dep)))) {
          descendants.add(normalized)
          grew = true
        }
      }
    }
    activeTasks = input.shot.tasks.map((task) => {
      const normalized = safeTaskId(task.id)
      if (!descendants.has(normalized)) {
        // Already landed: convert to a no-op materialize pass-through —
        // writes a marker file (satisfies the plan validator's non-empty
        // constraints), runs no agent, no oracle; the DAG placeholder lets
        // children's integration bases resolve against main HEAD.
        const marker = `.spec-landed/${safeTaskId(task.id)}`
        return { ...task, loop: undefined, acceptanceCommands: [], executor: "materialize" as const, materializedFiles: { [marker]: `reused from v1: ${task.id}\n` }, scope: [...task.scope, marker] }
      }
      return task
    })
  }

  const effectiveTasks = activeTasks
  const ids = new Map(effectiveTasks.map((task) => [task.id, safeTaskId(task.id)]))
  if (new Set(ids.values()).size !== ids.size) throw new Error("generation task ids collide after Git ref normalization")
  const reserved = new Set(["compiler-seed", "conformance", ...(input.finalMaterializations ?? []).map((item) => safeTaskId(item.id))])
  const collision = [...ids.values()].find((id) => reserved.has(id))
  if (collision) throw new Error(`generation task id collides with compiler execution node: ${collision}`)
  if (reserved.size !== 2 + (input.finalMaterializations?.length ?? 0)) {
    throw new Error("compiler materialization ids must be unique")
  }

  const tasks: AgentExecutionTask[] = []
  const seedFiles = {
    ...(input.shot.seedFiles ?? {}),
    ...Object.fromEntries(
      Object.entries(input.shot.semanticFiles ?? {}).map(([file, content]) => [`.spec-input/${file}`, content]),
    ),
  }
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

  for (const task of effectiveTasks) {
    const taskDirectory = task.workingDirectory
      ? inTarget(directory, task.workingDirectory)
      : directory
    tasks.push({
      id: ids.get(task.id)!,
      objective: task.label ?? task.id,
      instruction: task.prompt,
      executor: task.executor ?? "agent",
      dependsOn: task.dependsOn.length > 0
        ? task.dependsOn.map((dependency) => ids.get(dependency)!).sort()
        : hasSeed ? ["compiler-seed"] : [],
      workingDirectory: taskDirectory,
      ...(task.materializedFiles !== undefined ? { materializedFiles: task.materializedFiles } : {}),
      scope: task.scope.map((file) => inTarget(directory, file)).sort(),
      specNodeIds: [...(task.specNodeIds ?? [])].sort(),
      ...(task.loop ? {
        loop: {
          ...task.loop,
          implementation: {
            ...task.loop.implementation,
            scope: task.loop.implementation.scope.map((file) => inTarget(directory, file)).sort(),
          },
          reviewer: {
            ...task.loop.reviewer,
            ...(task.loop.reviewer.oracleFiles ? {
              oracleFiles: task.loop.reviewer.oracleFiles.map((file) => inTarget(directory, file)).sort(),
            } : {}),
            // Clause nodes are named after generation tasks, whose ids are
            // normalized for Git refs ("router:Booking" → "router-Booking").
            // Remap the node so loop validation sees the task it belongs to;
            // a node that names no task keeps its value and is rejected.
            ...(task.loop.reviewer.clauses ? {
              clauses: task.loop.reviewer.clauses.map((clause) => ({
                ...clause,
                node: ids.get(clause.node) ?? clause.node,
              })),
            } : {}),
          },
        },
      } : {}),
      acceptance: {
        requiredChecks: input.requiredChecks,
        commands: task.acceptanceCommands?.length ? [...task.acceptanceCommands] : ["git diff --check"],
      },
    })
  }

  const generationSinks = effectiveTasks
    .filter((candidate) => !effectiveTasks.some((task) => task.dependsOn.includes(candidate.id)))
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
    defaultBranch: input.defaultBranch,
    rootBaseSha: input.rootBaseSha,
    branchPrefix: "spec/generate",
    ...(input.planVersion !== undefined && input.planVersion > 1 ? { planVersion: input.planVersion } : {}),
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
  // The copy must be re-runnable: a retried or repeated exec merges into an
  // already-populated tree, where `cp -R src/. dst/` fails on existing
  // read-only or conflicting entries. A tar extraction is idempotent, and
  // excluding plugin caches and session transcripts keeps the per-container
  // boot copy at a few megabytes instead of hundreds.
  const bootstrap = [
    "set -eu",
    "mkdir -p /home/node/.claude",
    "if [ -d /opt/spec-host-claude ]; then tar -C /opt/spec-host-claude -cf - --exclude=./plugins --exclude=./projects . | tar -C /home/node/.claude -xpf - --skip-old-files; fi",
    "if [ -f /opt/spec-host-claude.json ]; then cp /opt/spec-host-claude.json /home/node/.claude.json; fi",
  ].join("; ")
  if ((options.concurrency ?? 1) !== plan.environment.agent.maxConcurrency) {
    throw new Error("runtime concurrency does not match the immutable agent environment")
  }
  if (options.model !== plan.environment.agent.model ||
      options.effort !== plan.environment.agent.effort ||
      options.maxTurns !== plan.environment.agent.maxTurns) {
    throw new Error("runtime agent settings do not match the immutable agent environment")
  }
  const agentCommand = [
    "claude",
    ...buildClaudeArgs({ model: options.model, effort: options.effort, maxTurns: options.maxTurns }),
  ]
  const reviewerCommand = [
    "claude",
    ...buildClaudeArgs({
      model: options.reviewerModel ?? options.model,
      effort: options.effort,
      maxTurns: options.maxTurns,
      permissionMode: "plan",
      allowedTools: [
        "Read", "Glob", "Grep", "LS", "Bash(uv:*)", "Bash(python:*)", "Bash(python3:*)",
        "Bash(.venv/bin/python:*)", "Bash(pytest:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)",
        "Bash(tail:*)", "Bash(wc:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(sed:*)",
      ],
    }),
  ]

  // The two environment axes are assembled independently: the runtime picks
  // where the agent and acceptance commands execute, the control plane picks
  // which durable-branch implementation verifies and lands task heads.
  const events = openEventLog(options.eventsRoot, {
    run: options.runId ?? "unknown-run",
    ...(options.shot !== undefined ? { shot: options.shot } : {}),
  })
  const containers = options.runtime === "host"
    ? new HostAgentExecutor({ agentCommand, reviewerAgentCommand: reviewerCommand, events })
    : new DockerAgentExecutor({
        mounts,
        environmentVariables,
        literalEnvironment: { PYTHONDONTWRITEBYTECODE: "1" },
        initializationCommand: ["/bin/sh", "-lc", bootstrap],
        agentCommand,
        reviewerAgentCommand: reviewerCommand,
        events,
      })
  const controlPlane = options.execution === "local"
    ? new LocalGitControlPlane({
        repoRoot,
        verificationRoot: path.join(path.dirname(worktreeRoot), "verification"),
      })
    : new GitHubCliAdapter({ cwd: repoRoot })

  return runAgentExecutionPlan(plan, {
    repository: new GitAgentExecutionRepository({ repoRoot, worktreeRoot }),
    containers,
    controlPlane,
    concurrency: options.concurrency,
    failFast: true,
    resume: options.resume,
    onTaskStart: (task) => options.onTaskStart?.(task.id),
    onTaskEnd: (result) => options.onTaskEnd?.(result.taskId, result.status !== "failure", result.headSha),
  })
}
