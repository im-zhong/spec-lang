import * as fs from "node:fs"
import * as path from "node:path"
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
  agentCommand?: string[]
  environmentVariables?: string[]
  mounts?: DockerMount[]
  timeoutMs?: number
}

const DEFAULT_AGENT_COMMAND = [
  "claude", "-p", "--output-format", "json", "--permission-mode", "acceptEdits",
  "--allowedTools",
  "Read", "Glob", "Grep", "LS", "Edit", "Write",
  "Bash(uv:*)", "Bash(python:*)", "Bash(python3:*)", "Bash(.venv/bin/python:*)",
  "Bash(pytest:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)",
  "Bash(wc:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(mkdir:*)", "Bash(sed:*)",
]

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
      if (task.executor === "materialize") {
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
        const agent = await runProcess(
          docker,
          ["exec", "-i", name, ...(this.options.agentCommand ?? DEFAULT_AGENT_COMMAND)],
          { input: task.instruction, timeoutMs },
        )
        checks.push({ name: "generation/agent", status: agent.ok ? "success" : "failure" })
        if (!agent.ok) error = commandFailure(agent).message
        if (agent.ok) {
          try {
            const payload = JSON.parse(agent.stdout) as { total_cost_usd?: unknown }
            if (typeof payload.total_cost_usd === "number") costUsd = payload.total_cost_usd
          } catch {
            // Agent output is evidence only; its exit code is authoritative here.
          }
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
