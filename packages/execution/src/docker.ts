import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import type { AgentExecutionCheckResult, ResolvedAgentExecutionTask } from "@spec/core"
import { commandFailure, runProcess } from "./process"
import type { ContainerExecutionResult, AgentExecutionContainerPort } from "./ports"

export interface DockerMount {
  source: string
  target: string
  readOnly?: boolean
}

export interface DockerAgentExecutorOptions {
  dockerCli?: string
  /** Run once after container start, before any parallel agent processes. */
  initializationCommand?: string[]
  /** Wall-clock budget for the initialization exec (default 5 minutes). */
  initializationTimeoutMs?: number
  agentCommand?: string[]
  /** Read-only Claude command used for the reviewer role. */
  reviewerAgentCommand?: string[]
  /** Environment variable names forwarded from the invoking process. */
  environmentVariables?: string[]
  /** Literal environment variables set verbatim in every agent container. */
  literalEnvironment?: Record<string, string>
  mounts?: DockerMount[]
  timeoutMs?: number
}

const DEFAULT_AGENT_COMMAND = [
  "claude", "-p", "--output-format", "json", "--safe-mode", "--no-session-persistence",
  "--permission-mode", "acceptEdits",
  "--allowedTools",
  "Read", "Glob", "Grep", "LS", "Edit", "Write",
  "Bash(uv:*)", "Bash(python:*)", "Bash(python3:*)", "Bash(.venv/bin/python:*)",
  "Bash(pytest:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)",
  "Bash(wc:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(mkdir:*)", "Bash(sed:*)",
]

const DEFAULT_REVIEWER_COMMAND = [
  "claude", "-p", "--output-format", "json", "--safe-mode", "--no-session-persistence",
  "--permission-mode", "plan", "--allowedTools",
  "Read", "Glob", "Grep", "LS", "Bash(uv:*)", "Bash(python:*)", "Bash(python3:*)",
  "Bash(.venv/bin/python:*)", "Bash(pytest:*)", "Bash(ls:*)", "Bash(cat:*)",
  "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(sed:*)",
]

function parseAgentEnvelope(stdout: string): Record<string, unknown> | undefined {
  const starts = [stdout.lastIndexOf("\n{"), stdout.indexOf("{")]
    .map((index) => index < 0 ? -1 : index + (stdout[index] === "\n" ? 1 : 0))
    .filter((index, position, values) => index >= 0 && values.indexOf(index) === position)
  for (const start of starts) {
    try {
      const value = JSON.parse(stdout.slice(start).trim())
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      // Try the next complete JSON object after bounded CLI noise.
    }
  }
  return undefined
}

function agentCost(stdout: string): number {
  const payload = parseAgentEnvelope(stdout)
  return typeof payload?.total_cost_usd === "number" ? payload.total_cost_usd : 0
}

/**
 * The verdict is a judge interface, so parsing must be mechanical and
 * tolerant of model formatting: the JSON object may be wrapped in markdown
 * fences or surrounded by prose inside the agent's result string.
 */
function extractVerdictObject(text: string): Record<string, unknown> | undefined {
  const candidates: string[] = []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/g)
  for (const block of fenced ?? []) candidates.push(block.replace(/```(?:json)?\s*|\s*```/g, ""))
  candidates.push(text)
  let start = text.indexOf("{")
  while (start >= 0) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index++) {
      const character = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === "\\") escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') inString = true
      else if (character === "{") depth++
      else if (character === "}") {
        depth--
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1))
          break
        }
      }
    }
    start = text.indexOf("{", start + 1)
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed
    } catch {
      // Try the next candidate form.
    }
  }
  return undefined
}

function reviewerVerdict(stdout: string): { approved: boolean; feedback: string } | undefined {
  try {
    const envelope = parseAgentEnvelope(stdout)
    if (!envelope) return undefined
    const raw = typeof envelope.result === "string" ? envelope.result : JSON.stringify(envelope)
    const candidate = extractVerdictObject(raw)
    if (!candidate || typeof candidate.approved !== "boolean") return undefined
    return {
      approved: candidate.approved,
      feedback: typeof candidate.feedback === "string" ? candidate.feedback : "",
    }
  } catch {
    return undefined
  }
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120)
}

function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".spec-loop") continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).replaceAll("\\", "/")
        files.set(relative, createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"))
      }
    }
  }
  visit(root)
  return files
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort()
}

/**
 * Interpreter and test-runner byproducts (Python bytecode, pytest cache) are
 * created automatically when probes execute, so they are never evidence of an
 * agent writing outside its scope. Everything else stays a violation.
 */
function isToolArtifact(file: string): boolean {
  return file.includes("__pycache__/") || file.endsWith(".pyc") || file.includes(".pytest_cache/")
}

function roleScope(task: ResolvedAgentExecutionTask, files: string[]): string[] {
  const prefix = task.workingDirectory ? `${task.workingDirectory.replace(/\/$/, "")}/` : ""
  return files.map((file) => {
    if (prefix && !file.startsWith(prefix)) throw new Error(`loop role scope ${file} is outside ${task.workingDirectory}`)
    return prefix ? file.slice(prefix.length) : file
  })
}

function mergeRoleChanges(
  taskDirectory: string,
  roleDirectory: string,
  before: Map<string, string>,
  allowedFiles: string[],
  role: string,
): string | undefined {
  const after = snapshot(roleDirectory)
  const changes = changedPaths(before, after).filter((file) => !isToolArtifact(file))
  const allowed = new Set(allowedFiles)
  const violations = changes.filter((file) => !allowed.has(file))
  if (violations.length > 0) return `${role} agent wrote outside its declared scope: ${violations.join(", ")}`
  for (const file of changes) {
    const source = path.join(roleDirectory, file)
    const destination = path.join(taskDirectory, file)
    if (!fs.existsSync(source)) {
      if (fs.existsSync(destination)) fs.rmSync(destination)
      continue
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
  }
  return undefined
}

export class DockerAgentExecutor implements AgentExecutionContainerPort {
  private readonly options: DockerAgentExecutorOptions

  constructor(options: DockerAgentExecutorOptions = {}) {
    this.options = options
  }

  async execute(task: ResolvedAgentExecutionTask, workspace: string): Promise<ContainerExecutionResult> {
    const docker = this.options.dockerCli ?? "docker"
    const name = safeName(`spec-dev-${task.runId}-${task.id}`)
    const timeoutMs = this.options.timeoutMs ?? 45 * 60_000
    const taskDirectory = task.workingDirectory
      ? path.join(path.resolve(workspace), task.workingDirectory)
      : path.resolve(workspace)
    fs.mkdirSync(taskDirectory, { recursive: true })
    const containerWorkdir = task.workingDirectory
      ? `/workspace/${task.workingDirectory.replace(/^\.\//, "")}`
      : "/workspace"
    const labels = ["--label", `spec.run=${task.runId}`, "--label", `spec.task=${task.id}`]
    const isAgentTask = task.executor !== "materialize"
    const mountArgs = ["--mount", `type=bind,source=${path.resolve(workspace)},target=/workspace`]
    for (const mount of isAgentTask ? this.options.mounts ?? [] : []) {
      mountArgs.push("--mount", `type=bind,source=${path.resolve(mount.source)},target=${mount.target}${mount.readOnly ? ",readonly" : ""}`)
    }
    const environmentArgs = (isAgentTask ? this.options.environmentVariables ?? [] : []).flatMap((name) => ["--env", name])
    const literalEnvironmentArgs = (isAgentTask
      ? Object.entries(this.options.literalEnvironment ?? {})
      : []).flatMap(([name, value]) => ["--env", `${name}=${value}`])

    const inspect = await runProcess(docker, ["inspect", name], { timeoutMs: 30_000 })
    if (inspect.ok) {
      const labelsResult = await runProcess(docker, ["inspect", "--format", "{{ index .Config.Labels \"spec.run\" }}/{{ index .Config.Labels \"spec.task\" }}", name], { timeoutMs: 30_000 })
      if (!labelsResult.ok || labelsResult.stdout.trim() !== `${task.runId}/${task.id}`) {
        return { ok: false, checks: [], error: `refusing to reuse unrelated Docker container named ${name}` }
      }
      const removed = await runProcess(docker, ["rm", "-f", name], { timeoutMs: 60_000 })
      if (!removed.ok) return { ok: false, checks: [], error: commandFailure(removed).message }
    }

    const create = await runProcess(docker, [
      "create", "--name", name,
      ...labels,
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=1g",
      "--tmpfs", "/home/node:rw,nosuid,size=2g,uid=1000,gid=1000",
      "--workdir", containerWorkdir,
      ...mountArgs,
      ...environmentArgs,
      ...literalEnvironmentArgs,
      task.environment.image,
      "tail", "-f", "/dev/null",
    ], { timeoutMs: 10 * 60_000 })
    if (!create.ok) return { ok: false, checks: [], error: commandFailure(create).message }
    const started = await runProcess(docker, ["start", name], { timeoutMs: 60_000 })
    if (!started.ok) {
      const removed = await runProcess(docker, ["rm", "-f", name], { timeoutMs: 60_000 })
      const cleanup = removed.ok ? "" : `; cleanup failed: ${commandFailure(removed).message}`
      return { ok: false, checks: [], error: `${commandFailure(started).message}${cleanup}` }
    }

    const checks: AgentExecutionCheckResult[] = []
    let costUsd: number | undefined
    let error: string | undefined
    let cleanupError: string | undefined
    try {
      if (isAgentTask && this.options.initializationCommand) {
        // Concurrent task boots each copy the host credential tree, so this
        // exec competes for I/O with every sibling container: allow minutes.
        const initialized = await runProcess(
          docker,
          ["exec", name, ...this.options.initializationCommand],
          { timeoutMs: this.options.initializationTimeoutMs ?? 300_000 },
        )
        checks.push({ name: "generation/initialize", status: initialized.ok ? "success" : "failure" })
        if (!initialized.ok) error = commandFailure(initialized).message
      }
      if (error) {
        // Initialization is infrastructure, so no writer or reviewer starts.
      } else if (task.executor === "materialize") {
        for (const [relative, content] of Object.entries(task.materializedFiles ?? {})) {
          const destination = path.resolve(taskDirectory, relative)
          const directoryPrefix = taskDirectory.endsWith(path.sep) ? taskDirectory : `${taskDirectory}${path.sep}`
          if (!destination.startsWith(directoryPrefix)) {
            error = `compiler-owned materialization escapes task working directory: ${relative}`
            break
          }
          fs.mkdirSync(path.dirname(destination), { recursive: true })
          fs.writeFileSync(destination, content, "utf8")
        }
        checks.push({ name: "generation/materialize", status: error ? "failure" : "success" })
      } else {
        if (task.loop) {
          let feedback = ""
          let approved = false
          costUsd = 0
          for (let round = 1; round <= task.loop.maxRounds; round++) {
            const shared = `\n\n# Frozen node context\nTask: ${task.id}\nRound: ${round}/${task.loop.maxRounds}\n` +
              (feedback ? `Reviewer feedback from the prior round:\n${feedback}\n` : "This is the first round.\n")
            const implementationPrompt = `${task.loop.implementation.instruction}${shared}\nYou own only: ${task.loop.implementation.scope.join(", ")}. Do not edit tests.`
            const testsPrompt = `${task.loop.tests.instruction}${shared}\nYou own only: ${task.loop.tests.scope.join(", ")}. Do not edit implementation files.`
            const loopRoot = path.join(path.resolve(workspace), ".spec-loop", safeName(task.id), String(round))
            const implementationDirectory = path.join(loopRoot, "implementation")
            const testsDirectory = path.join(loopRoot, "tests")
            fs.rmSync(loopRoot, { recursive: true, force: true })
            fs.mkdirSync(loopRoot, { recursive: true })
            fs.cpSync(taskDirectory, implementationDirectory, { recursive: true })
            fs.cpSync(taskDirectory, testsDirectory, { recursive: true })
            const before = snapshot(taskDirectory)
            const implementationWorkdir = `/workspace/${path.relative(path.resolve(workspace), implementationDirectory).replaceAll("\\", "/")}`
            const testsWorkdir = `/workspace/${path.relative(path.resolve(workspace), testsDirectory).replaceAll("\\", "/")}`
            const [implementation, tests] = await Promise.all([
              runProcess(docker, ["exec", "-w", implementationWorkdir, "-i", name, ...(this.options.agentCommand ?? DEFAULT_AGENT_COMMAND)], { input: implementationPrompt, timeoutMs }),
              runProcess(docker, ["exec", "-w", testsWorkdir, "-i", name, ...(this.options.agentCommand ?? DEFAULT_AGENT_COMMAND)], { input: testsPrompt, timeoutMs }),
            ])
            checks.push({ name: `generation/loop/${round}/implementation`, status: implementation.ok ? "success" : "failure" })
            checks.push({ name: `generation/loop/${round}/tests`, status: tests.ok ? "success" : "failure" })
            costUsd += agentCost(implementation.stdout) + agentCost(tests.stdout)
            if (!implementation.ok || !tests.ok) {
              error = commandFailure(!implementation.ok ? implementation : tests).message
              fs.rmSync(loopRoot, { recursive: true, force: true })
              break
            }
            const directWrites = changedPaths(before, snapshot(taskDirectory))
            if (directWrites.length > 0) {
              error = `parallel loop agents bypassed their isolated snapshots: ${directWrites.join(", ")}`
              fs.rmSync(loopRoot, { recursive: true, force: true })
              break
            }
            const implementationViolation = mergeRoleChanges(
              taskDirectory,
              implementationDirectory,
              before,
              roleScope(task, task.loop.implementation.scope),
              "implementation",
            )
            const testsViolation = mergeRoleChanges(
              taskDirectory,
              testsDirectory,
              before,
              roleScope(task, task.loop.tests.scope),
              "tests",
            )
            fs.rmSync(loopRoot, { recursive: true, force: true })
            if (implementationViolation || testsViolation) {
              error = implementationViolation ?? testsViolation
              break
            }

            const testEvidence: string[] = []
            for (const command of task.loop.reviewer.commands) {
              const result = await runProcess(docker, ["exec", name, "/bin/sh", "-lc", command], { timeoutMs })
              testEvidence.push(`$ ${command}\nexit=${result.exitCode}\n${result.stdout}\n${result.stderr}`)
            }
            const reviewPrompt = `${task.loop.reviewer.instruction}${shared}
Review the implementation and generated tests against the frozen task/spec. The test evidence is:
${testEvidence.join("\n\n")}
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes for both code and tests"}. Approve only when code, tests, and constraints all conform.`
            const beforeReviewer = snapshot(taskDirectory)
            const review = await runProcess(
              docker,
              ["exec", "-i", name, ...(this.options.reviewerAgentCommand ?? DEFAULT_REVIEWER_COMMAND)],
              { input: reviewPrompt, timeoutMs },
            )
            checks.push({ name: `generation/loop/${round}/review`, status: review.ok ? "success" : "failure" })
            costUsd += agentCost(review.stdout)
            if (!review.ok) {
              error = commandFailure(review).message
              break
            }
            const reviewerWrites = changedPaths(beforeReviewer, snapshot(taskDirectory))
            if (reviewerWrites.length > 0) {
              error = `reviewer for ${task.id} modified files despite its read-only role: ${reviewerWrites.join(", ")}`
              break
            }
            const verdict = reviewerVerdict(review.stdout)
            if (!verdict) {
              // Keep bounded reviewer output: an unparseable verdict is a
              // judge failure whose evidence must not be discarded.
              const tail = review.stdout.length > 2_000 ? `…${review.stdout.slice(-2_000)}` : review.stdout
              error = `reviewer for ${task.id} round ${round} returned no structured verdict; reviewer output: ${tail}`
              break
            }
            if (verdict.approved) {
              approved = true
              break
            }
            feedback = verdict.feedback || "Reviewer rejected the round without actionable feedback. Re-check the complete task contract."
          }
          if (!error && !approved) error = `agent loop for ${task.id} exhausted ${task.loop.maxRounds} rounds without approval`
        } else {
          const agent = await runProcess(
            docker,
            ["exec", "-i", name, ...(this.options.agentCommand ?? DEFAULT_AGENT_COMMAND)],
            { input: task.instruction, timeoutMs },
          )
          checks.push({ name: "generation/agent", status: agent.ok ? "success" : "failure" })
          if (!agent.ok) error = commandFailure(agent).message
          if (agent.ok) costUsd = agentCost(agent.stdout)
        }
      }
      if (!error) {
        for (let index = 0; index < task.acceptance.commands.length; index++) {
          const command = task.acceptance.commands[index]
          const result = await runProcess(docker, ["exec", name, "/bin/sh", "-lc", command], { timeoutMs })
          checks.push({ name: `generation/container/${index + 1}`, status: result.ok ? "success" : "failure" })
          if (!result.ok) {
            error = commandFailure(result).message
            break
          }
        }
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      // A container cannot outlive the worktree mounted into it. Diagnostic
      // retention belongs in logs/artifacts; keeping this container would race
      // the orchestrator's unconditional worktree cleanup.
      const removed = await runProcess(docker, ["rm", "-f", name], { timeoutMs: 60_000 })
      if (!removed.ok) cleanupError = commandFailure(removed).message
    }
    if (cleanupError) error = error ? `${error}; cleanup failed: ${cleanupError}` : `container cleanup failed: ${cleanupError}`
    return { ok: error === undefined, checks, costUsd, ...(error ? { error } : {}) }
  }
}
