import * as fs from "node:fs"
import * as path from "node:path"
import type { AgentExecutionCheckResult, ResolvedAgentExecutionTask } from "@spec/core"
import { commandFailure, runProcess } from "./process"
import { DEFAULT_AGENT_COMMAND, DEFAULT_REVIEWER_COMMAND, executeAgentTask, type AgentTaskRunner } from "./agent-task"
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

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120)
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
      const removed = await runProcess(docker, ["rm", "-f", "-v", name], { timeoutMs: 60_000 })
      if (!removed.ok) return { ok: false, checks: [], error: commandFailure(removed).message }
    }

    const create = await runProcess(docker, [
      "create", "--name", name,
      ...labels,
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=1g",
      // Agent credentials, CLI state, and uv packages can approach the whole
      // Docker VM's RAM when concurrent homes are tmpfs-backed. An anonymous
      // volume keeps each home isolated and disposable without consuming RAM
      // needed to mmap native Python extensions during oracle execution.
      "--mount", "type=volume,destination=/home/node",
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
      const removed = await runProcess(docker, ["rm", "-f", "-v", name], { timeoutMs: 60_000 })
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
      if (!error) {
        const runner: AgentTaskRunner = {
          agent: (command, prompt, agentTimeoutMs) => runProcess(
            docker,
            ["exec", "-w", containerWorkdir, "-i", name, ...command],
            { input: prompt, timeoutMs: agentTimeoutMs },
          ),
          shell: (command, shellTimeoutMs) => runProcess(
            docker,
            ["exec", "-w", containerWorkdir, name, "/bin/sh", "-lc", command],
            { timeoutMs: shellTimeoutMs },
          ),
        }
        const outcome = await executeAgentTask(task, taskDirectory, runner, {
          agentCommand: this.options.agentCommand ?? DEFAULT_AGENT_COMMAND,
          reviewerAgentCommand: this.options.reviewerAgentCommand ?? DEFAULT_REVIEWER_COMMAND,
          timeoutMs,
        })
        checks.push(...outcome.checks)
        costUsd = outcome.costUsd
        error = outcome.error
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      // A container cannot outlive the worktree mounted into it. Diagnostic
      // retention belongs in logs/artifacts; keeping this container would race
      // the orchestrator's unconditional worktree cleanup.
      const removed = await runProcess(docker, ["rm", "-f", "-v", name], { timeoutMs: 60_000 })
      if (!removed.ok) cleanupError = commandFailure(removed).message
    }
    if (cleanupError) error = error ? `${error}; cleanup failed: ${cleanupError}` : `container cleanup failed: ${cleanupError}`
    return { ok: error === undefined, checks, costUsd, ...(error ? { error } : {}) }
  }
}
