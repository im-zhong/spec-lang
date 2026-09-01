/**
 * The agent harness: executes a generation DAG with a coding agent.
 *
 * The harness is the compiler's answer to "code has structure":
 *
 *   - tasks arrive as a DAG (dependencies = readable prior artifacts);
 *   - execution follows topological order (sequential by default — two
 *     agents must never write the same workspace concurrently);
 *   - every task gets a NARROW prompt (its scope, its context files);
 *   - the harness audits each task: which files it created/modified,
 *     and whether it stayed inside its declared scope;
 *   - there is NO repair here and NO grading here — verification is the
 *     compiler's job (see orchestrate.ts). A failed task fails the shot.
 */
import type { Artifact } from "@spec/core"
import { scanArtifacts, sha256 } from "./artifacts"
import { ClaudeCodeAgentRunner, type AgentRunResult } from "./runner"

export interface HarnessTask {
  id: string
  label?: string
  dependsOn: string[]
  /** Files the task is allowed to create/modify. */
  scope: string[]
  prompt: string
  specNodeIds?: string[]
}

export interface HarnessTaskResult {
  id: string
  ok: boolean
  run: AgentRunResult
  /** Files this task created or modified (path → sha256 after the run). */
  produced: Array<{ path: string; sha256: string }>
  /** Files touched outside the declared scope (harness audit). */
  scopeViolations: string[]
  durationMs: number
  /** Agent runs issued for this task (1 = first try; retries add more). */
  attempts: number
}

export interface HarnessReport {
  ok: boolean
  results: HarnessTaskResult[]
  totalCostUsd: number
}

export interface HarnessOptions {
  runner: ClaudeCodeAgentRunner
  /** Max concurrently running tasks. Default 1 (sequential, deterministic). */
  concurrency?: number
  /**
   * Retries for agent-RUN failures (CLI crash, turn-budget exhaustion).
   * This is infrastructure tolerance, NOT repair: the identical prompt is
   * re-issued when a run itself fails — conformance failures are never
   * retried or patched (see the golden rule). Default 1.
   */
  taskRetries?: number
  onTaskStart?: (task: HarnessTask) => void
  onTaskEnd?: (result: HarnessTaskResult) => void
}

export class AgentHarness {
  private readonly options: HarnessOptions

  constructor(options: HarnessOptions) {
    this.options = options
  }

  async execute(workspace: string, tasks: HarnessTask[]): Promise<HarnessReport> {
    const order = schedule(tasks)
    const results: HarnessTaskResult[] = []
    const completed = new Set<string>()
    let totalCostUsd = 0

    for (const task of order) {
      for (const dep of task.dependsOn) {
        if (!completed.has(dep)) {
          throw new Error(`harness scheduling bug: task "${task.id}" ran before its dependency "${dep}"`)
        }
      }
      this.options.onTaskStart?.(task)
      const before = snapshotWorkspace(workspace)
      const started = Date.now()
      let attempts = 0
      let run = await this.options.runner.run(task.prompt, workspace)
      attempts++
      const maxAttempts = 1 + (this.options.taskRetries ?? 1)
      while (!run.ok && attempts < maxAttempts) {
        // the run itself failed (crash / turn budget), not the conformance
        // check — re-issue the identical prompt
        run = await this.options.runner.run(task.prompt, workspace)
        attempts++
      }
      const after = snapshotWorkspace(workspace)

      const produced: HarnessTaskResult["produced"] = []
      const scopeViolations: string[] = []
      for (const [path, hash] of after) {
        if (before.get(path) === hash) continue
        produced.push({ path, sha256: hash })
        if (!task.scope.includes(path)) scopeViolations.push(path)
      }

      const result: HarnessTaskResult = {
        id: task.id,
        ok: run.ok,
        run,
        produced,
        scopeViolations,
        durationMs: Date.now() - started,
        attempts,
      }
      results.push(result)
      totalCostUsd += run.costUsd ?? 0
      this.options.onTaskEnd?.(result)

      if (!run.ok) {
        // A failed task breaks the dependency chain — do not continue.
        return { ok: false, results, totalCostUsd }
      }
      completed.add(task.id)
    }
    return { ok: true, results, totalCostUsd }
  }
}

/** path → content hash, for everything the artifact scanner would see. */
function snapshotWorkspace(workspace: string): Map<string, string> {
  const artifacts: Artifact[] = scanArtifacts(workspace, { generatedBy: "snapshot" })
  const out = new Map<string, string>()
  for (const artifact of artifacts) {
    if (artifact.path === undefined || artifact.contentHash === undefined) continue
    out.set(artifact.path, artifact.contentHash)
  }
  return out
}

/**
 * Deterministic topological schedule (Kahn). Independent tasks run in
 * id order; concurrency is left to the caller's policy (default 1).
 */
export function schedule(tasks: HarnessTask[]): HarnessTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const pending = new Set(tasks.map((t) => t.id))
  const done = new Set<string>()
  const out: HarnessTask[] = []
  while (pending.size > 0) {
    const ready = [...pending]
      .filter((id) => byId.get(id)!.dependsOn.every((d) => done.has(d)))
      .sort()
    if (ready.length === 0) {
      throw new Error(`task graph has a cycle involving: ${[...pending].sort().join(", ")}`)
    }
    for (const id of ready) {
      out.push(byId.get(id)!)
      done.add(id)
      pending.delete(id)
    }
  }
  return out
}
