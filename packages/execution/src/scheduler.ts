import type { AgentExecutionTask } from "@spec/core"

export interface ScheduledTaskResult {
  taskId: string
  ok: boolean
}

export interface AgentExecutionScheduleReport<Result extends ScheduledTaskResult> {
  ok: boolean
  results: Result[]
  skipped: string[]
  failures: AgentExecutionScheduleFailure[]
}

export interface AgentExecutionScheduleFailure {
  taskId: string
  phase: "worker" | "onTaskStart" | "onTaskEnd"
  name: string
  message: string
  stack?: string
}

export interface AgentExecutionScheduleOptions<Result extends ScheduledTaskResult> {
  concurrency?: number
  /** Stop launching new work after the first unsuccessful task result. */
  failFast?: boolean
  onTaskStart?: (task: AgentExecutionTask) => void
  onTaskEnd?: (result: Result) => void
}

interface FulfilledTask<Result> {
  id: string
  status: "fulfilled"
  result: Result
}

interface RejectedTask {
  id: string
  status: "rejected"
  reason: unknown
}

type SettledTask<Result> = FulfilledTask<Result> | RejectedTask

function failure(taskId: string, phase: AgentExecutionScheduleFailure["phase"], reason: unknown): AgentExecutionScheduleFailure {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  return {
    taskId,
    phase,
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  }
}

/**
 * Run ready tasks concurrently. A child is released only after every parent
 * returned a successful durable result; failed ancestry is reported skipped.
 */
export async function runAgentExecutionSchedule<Result extends ScheduledTaskResult>(
  tasks: AgentExecutionTask[],
  worker: (task: AgentExecutionTask, dependencies: Result[]) => Promise<Result>,
  options: AgentExecutionScheduleOptions<Result> = {},
): Promise<AgentExecutionScheduleReport<Result>> {
  const concurrency = options.concurrency ?? 4
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("agent execution concurrency must be a positive integer")
  const byId = new Map(tasks.map((task) => [task.id, task]))
  if (byId.size !== tasks.length) throw new Error("agent execution schedule received duplicate task ids")
  const pending = new Set(byId.keys())
  const results = new Map<string, Result>()
  const skipped = new Set<string>()
  const failures: AgentExecutionScheduleFailure[] = []
  const running = new Map<string, Promise<SettledTask<Result>>>()

  const stopScheduling = (): void => {
    for (const id of pending) skipped.add(id)
    pending.clear()
  }

  while (pending.size > 0 || running.size > 0) {
    let changed = true
    while (changed) {
      changed = false
      for (const id of [...pending].sort()) {
        const task = byId.get(id)!
        if (task.dependsOn.some((dependency) => skipped.has(dependency) || results.get(dependency)?.ok === false)) {
          pending.delete(id)
          skipped.add(id)
          changed = true
        }
      }
    }

    const ready = [...pending]
      .filter((id) => byId.get(id)!.dependsOn.every((dependency) => results.get(dependency)?.ok === true))
      .sort()
    while (running.size < concurrency && ready.length > 0) {
      const id = ready.shift()!
      const task = byId.get(id)!
      pending.delete(id)
      try {
        options.onTaskStart?.(task)
      } catch (error) {
        failures.push(failure(id, "onTaskStart", error))
        stopScheduling()
        break
      }
      const dependencies = task.dependsOn.map((dependency) => results.get(dependency)!)
      // A running promise is always fulfilled with its settled state. This
      // keeps Promise.race from abandoning sibling tasks after one rejection.
      const promise: Promise<SettledTask<Result>> = worker(task, dependencies).then(
        (result): SettledTask<Result> => ({ id, status: "fulfilled", result }),
        (reason): SettledTask<Result> => ({ id, status: "rejected", reason }),
      )
      running.set(id, promise)
    }

    if (running.size === 0) {
      if (pending.size > 0) throw new Error(`agent execution graph is blocked or cyclic: ${[...pending].sort().join(", ")}`)
      break
    }
    const completed = await Promise.race(running.values())
    running.delete(completed.id)
    if (completed.status === "rejected") {
      failures.push(failure(completed.id, "worker", completed.reason))
      stopScheduling()
      continue
    }
    if (completed.result.taskId !== completed.id) {
      failures.push(failure(
        completed.id,
        "worker",
        new Error(`agent execution worker returned result for "${completed.result.taskId}" while running "${completed.id}"`),
      ))
      stopScheduling()
      continue
    }
    results.set(completed.id, completed.result)
    try {
      options.onTaskEnd?.(completed.result)
    } catch (error) {
      failures.push(failure(completed.id, "onTaskEnd", error))
      stopScheduling()
    }
    if (options.failFast && !completed.result.ok) stopScheduling()
  }

  const orderedResults = tasks
    .map((task) => results.get(task.id))
    .filter((result): result is Result => result !== undefined)
  return {
    ok: failures.length === 0 && skipped.size === 0 && orderedResults.length === tasks.length && orderedResults.every((result) => result.ok),
    results: orderedResults,
    skipped: [...skipped].sort(),
    failures,
  }
}
