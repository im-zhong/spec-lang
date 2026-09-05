import * as path from "node:path"
import type { ResolvedAgentExecutionTask } from "@spec/core"
import { runProcess } from "./process"
import { DEFAULT_AGENT_COMMAND, DEFAULT_REVIEWER_COMMAND, executeAgentTask, type AgentTaskRunner } from "./agent-task"
import type { EventLog } from "./events"
import type { ContainerExecutionResult, AgentExecutionContainerPort } from "./ports"

export interface HostAgentExecutorOptions {
  agentCommand?: string[]
  /** Read-only Claude command used for the reviewer role. */
  reviewerAgentCommand?: string[]
  timeoutMs?: number
  /** Telemetry sink for agent activity events. */
  events?: EventLog
}

/**
 * Fast-iteration execution environment: the coding agent, the loop oracle
 * commands, and acceptance all run directly on the host inside the task's
 * worktree — no container lifecycle, no registry pull, no CI round trip.
 *
 * The host is assumed to provide the pinned toolchain (uv/python/claude).
 * The frozen image digest in the plan stays the toolchain identity of record;
 * it is simply not enforced by a container boundary here.
 */
export class HostAgentExecutor implements AgentExecutionContainerPort {
  private readonly options: HostAgentExecutorOptions

  constructor(options: HostAgentExecutorOptions = {}) {
    this.options = options
  }

  async execute(task: ResolvedAgentExecutionTask, workspace: string): Promise<ContainerExecutionResult> {
    const taskDirectory = task.workingDirectory
      ? path.join(path.resolve(workspace), task.workingDirectory)
      : path.resolve(workspace)
    const runner: AgentTaskRunner = {
      agent: (command, prompt, timeoutMs, onLine) => runProcess(
        command[0],
        command.slice(1),
        { cwd: taskDirectory, input: prompt, timeoutMs, onLine },
      ),
      shell: (command, timeoutMs) => runProcess(
        "/bin/sh",
        ["-lc", command],
        { cwd: taskDirectory, timeoutMs },
      ),
    }
    const outcome = await executeAgentTask(task, taskDirectory, runner, {
      agentCommand: this.options.agentCommand ?? DEFAULT_AGENT_COMMAND,
      reviewerAgentCommand: this.options.reviewerAgentCommand ?? DEFAULT_REVIEWER_COMMAND,
      timeoutMs: this.options.timeoutMs ?? 45 * 60_000,
      events: this.options.events,
    })
    return {
      ok: outcome.error === undefined,
      checks: outcome.checks,
      ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    }
  }
}
