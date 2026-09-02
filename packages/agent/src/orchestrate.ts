/**
 * Shot orchestration — the no-repair generation protocol.
 *
 * One shot = one independent generation, judged once:
 *
 *   1. fresh workspace (marked .spec-generated)
 *   2. the agent harness executes the generation DAG (topological order,
 *      one agent run per task, scope-audited)
 *   3. the compiler drops its own conformance suite into the workspace
 *   4. the compiler runs the verification plan — ONE attempt
 *
 * There is NO repair loop, by policy: if a shot does not conform on its
 * first verification, the specification/blueprint is under-pinned. The
 * correct response is to fix the spec (pin the behavior), then regenerate
 * all shots — never to patch the generated code until it passes.
 * Failures therefore report as design defects, not agent retry requests.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { spawn } from "node:child_process"
import type { Artifact, Diagnostic } from "@spec/core"
import { diagnostic } from "./diagnostics"
import { prepareWorkspace, scanArtifacts, STDERR_LOG_FILE } from "./artifacts"
import {
  AgentHarness,
  type HarnessReport,
  type HarnessTask,
  type HarnessTaskResult,
} from "./harness"
import { ClaudeCodeAgentRunner } from "./runner"

export interface VerificationCommand {
  name: string
  command: string
  timeoutMs: number
}

export interface ShotSpec {
  /** The generation DAG tasks (already topologically sortable). */
  tasks: HarnessTask[]
  /** Compiler-owned target runtime/contract files available to generation tasks. */
  seedFiles?: Record<string, string>
  /** Compiler-owned files written into the workspace after generation. */
  conformanceFiles: Record<string, string>
  /** Directories excluded from artifact scanning (compiler-owned). */
  conformanceDirs?: string[]
  /** Compiler-declared evidence produced by verification and committed with the conformance node. */
  evidenceFiles?: string[]
  /** Compiler-owned commands that create evidenceFiles after conformance succeeds. */
  evidenceCommands?: VerificationCommand[]
  verification: { setup: VerificationCommand[]; check: VerificationCommand[] }
  /** Artifact provenance label; defaults to the historical fastapi target. */
  generatedBy?: string
}

export interface CommandResult {
  name: string
  command: string
  exitCode: number | null
  output: string
  ok: boolean
  durationMs: number
}

export interface ShotReport {
  shot: string
  workspace: string
  ok: boolean
  tasks: HarnessTaskResult[]
  verification: { setup: CommandResult[]; check: CommandResult[] }
  artifacts: Artifact[]
  diagnostics: Diagnostic[]
  totalCostUsd: number
}

export interface ShotOptions {
  model?: string
  maxTurns?: number
}

const OUTPUT_TAIL = 8000

export function runCommand(
  command: string,
  cwd: string,
  name: string,
  timeoutMs = 120_000,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn("/bin/sh", ["-c", command], { cwd, env: { ...process.env, CI: "1" } })
    let output = ""
    let settled = false
    const finish = (exitCode: number | null, extra?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        name,
        command,
        exitCode,
        output: (output + (extra ?? "")).slice(-OUTPUT_TAIL),
        ok: exitCode === 0,
        durationMs: Date.now() - started,
      })
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(null, `\n<timed out after ${timeoutMs}ms>`)
    }, timeoutMs)
    child.stdout.on("data", (c: Buffer) => (output += c.toString()))
    child.stderr.on("data", (c: Buffer) => (output += c.toString()))
    child.on("error", (err) => finish(null, `\n<spawn error: ${err.message}>`))
    child.on("close", (code) => finish(code))
  })
}

export async function runShot(
  shot: string,
  workspace: string,
  spec: ShotSpec,
  options: ShotOptions = {},
): Promise<ShotReport> {
  const runner = new ClaudeCodeAgentRunner({
    model: options.model,
    maxTurns: options.maxTurns,
    stderrLogFile: path.join(workspace, STDERR_LOG_FILE),
  })
  // taskRetries is infrastructure tolerance only (identical prompt re-issued
  // when a run itself fails) — it never repairs conformance failures.
  const harness = new AgentHarness({ runner, taskRetries: 2 })
  const diagnostics: Diagnostic[] = []

  prepareWorkspace(workspace)

  // Target-owned runtime and contract files are materialized before the
  // agent runs. They are immutable context: tasks may import them but must
  // never create or modify them.
  for (const [rel, content] of Object.entries(spec.seedFiles ?? {})) {
    const target = path.join(workspace, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, "utf8")
  }

  /* 1 — the harness executes the generation DAG */
  const harnessReport: HarnessReport = await harness.execute(workspace, spec.tasks)
  const totalCostUsd = harnessReport.totalCostUsd

  if (!harnessReport.ok) {
    const failed = harnessReport.results.find((r) => !r.ok)
    diagnostics.push(
      diagnostic(
        "AGENT_TASK_FAILED",
        "error",
        `Generation task "${failed?.id ?? "?"}" failed: ${failed?.run.error ?? "unknown error"}`,
        { details: { shot, task: failed?.id, sessionId: failed?.run.sessionId } },
      ),
    )
    return {
      shot,
      workspace,
      ok: false,
      tasks: harnessReport.results,
      verification: { setup: [], check: [] },
      artifacts: [],
      diagnostics,
      totalCostUsd,
    }
  }

  // Scope audit: informative, not fatal — conformance is the judge.
  for (const result of harnessReport.results) {
    if (result.scopeViolations.length > 0) {
      diagnostics.push(
        diagnostic(
          "SCOPE_VIOLATION",
          "warning",
          `Task "${result.id}" modified files outside its declared scope: ${result.scopeViolations.join(", ")}.`,
          { details: { shot, task: result.id, files: result.scopeViolations } },
        ),
      )
    }
  }

  /* 2 — the compiler drops its conformance suite (compiler truth) */
  for (const [rel, content] of Object.entries(spec.conformanceFiles)) {
    const target = path.join(workspace, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, "utf8")
  }

  /* 3 — verification. ONE attempt. No repair. */
  const setup: CommandResult[] = []
  for (const cmd of spec.verification.setup) {
    setup.push(await runCommand(cmd.command, workspace, cmd.name, cmd.timeoutMs))
  }
  const check: CommandResult[] = []
  for (const cmd of spec.verification.check) {
    check.push(await runCommand(cmd.command, workspace, cmd.name, cmd.timeoutMs))
  }
  const verification = { setup, check }
  const ok = setup.every((c) => c.ok) && check.every((c) => c.ok)

  if (!ok) {
    const failing = [...setup, ...check].filter((c) => !c.ok)
    diagnostics.push(
      diagnostic(
        "GENERATION_NONCONFORMANT",
        "error",
        `Shot "${shot}" failed verification on its FIRST (and only) attempt: ${failing
          .map((f) => f.name)
          .join(", ")}. By the golden rule this is a specification/blueprint defect — pin the diverging behavior in the spec or the compiler, then regenerate all shots. Do not repair the generated code.`,
        {
          details: {
            shot,
            failures: failing.map((f) => ({
              name: f.name,
              command: f.command,
              exitCode: f.exitCode,
              output: f.output.slice(-3000),
            })),
          },
        },
      ),
    )
  } else {
    diagnostics.push(
      diagnostic(
        "AGENT_VERIFIED",
        "info",
        `Shot "${shot}" passed conformance on the first attempt.`,
        { details: { shot, checks: check.map((c) => c.name) } },
      ),
    )
  }

  /* 4 — artifacts with provenance */
  const artifacts = scanArtifacts(workspace, {
    excludeDirs: spec.conformanceDirs ?? ["conformance"],
    generatedBy: spec.generatedBy ?? "fastapi:dag",
    sourceNodes: [...new Set(spec.tasks.flatMap((t) => t.specNodeIds ?? []))].sort(),
  })

  return {
    shot,
    workspace,
    ok,
    tasks: harnessReport.results,
    verification,
    artifacts,
    diagnostics,
    totalCostUsd,
  }
}
