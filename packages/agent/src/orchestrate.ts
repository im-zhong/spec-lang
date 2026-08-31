/**
 * Shot orchestration: one independent generation → deterministic
 * verification → bounded repair → artifact scan.
 *
 * A "shot" is a full, independent pass over a generation plan:
 *
 *   1. fresh workspace (marked .spec-generated)
 *   2. agent writes the implementation from the deterministic prompt
 *   3. compiler drops its own conformance suite into the workspace
 *   4. compiler runs the verification plan (setup + check commands)
 *   5. on failure: repair prompts with the failing output, up to N rounds
 *   6. artifacts are hashed and reported with provenance
 *
 * Repeatability (the golden rule) is then measured ACROSS shots — see
 * repeatability.ts.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { spawn } from "node:child_process"
import type { Artifact, Diagnostic } from "@spec/core"
import { diagnostic } from "./diagnostics"
import { ClaudeCodeAgentRunner, type AgentRunResult } from "./runner"
import { prepareWorkspace, scanArtifacts } from "./artifacts"

export interface VerificationCommand {
  name: string
  command: string
  timeoutMs: number
}

export interface ShotSpec {
  implementPrompt: string
  repairPrompt: (failure: CommandResult) => string
  /** Compiler-owned files written into the workspace after generation. */
  conformanceFiles: Record<string, string>
  /** Directories excluded from artifact scanning (compiler-owned). */
  conformanceDirs?: string[]
  verification: { setup: VerificationCommand[]; check: VerificationCommand[] }
  specNodeIds: string[]
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
  generate: AgentRunResult
  repairs: Array<{ round: number; run: AgentRunResult; failure: CommandResult }>
  verification: { setup: CommandResult[]; check: CommandResult[] }
  artifacts: Artifact[]
  diagnostics: Diagnostic[]
  totalCostUsd: number
}

export interface ShotOptions {
  model?: string
  maxTurns?: number
  repairRounds?: number
  runner?: ClaudeCodeAgentRunner
  /** Skip the agent and only re-verify an existing workspace. */
  verifyOnly?: boolean
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
  const runner =
    options.runner ??
    new ClaudeCodeAgentRunner({
      model: options.model,
      maxTurns: options.maxTurns ?? 60,
      stderrLogFile: path.join(workspace, ".agent-stderr.log"),
    })
  const repairRounds = options.repairRounds ?? 2
  const diagnostics: Diagnostic[] = []
  const repairs: ShotReport["repairs"] = []
  let totalCostUsd = 0

  prepareWorkspace(workspace)

  /* 1 — agent implements the blueprint */
  let generate: AgentRunResult
  if (options.verifyOnly) {
    generate = { ok: true, resultText: "<verify-only: agent skipped>" }
  } else {
    generate = await runner.run(spec.implementPrompt, workspace)
    totalCostUsd += generate.costUsd ?? 0
    if (!generate.ok) {
      diagnostics.push(
        diagnostic(
          "AGENT_TASK_FAILED",
          "error",
          `Generation agent failed: ${generate.error ?? "unknown error"}`,
          { details: { shot, task: "fastapi:implement", sessionId: generate.sessionId } },
        ),
      )
      return {
        shot,
        workspace,
        ok: false,
        generate,
        repairs,
        verification: { setup: [], check: [] },
        artifacts: [],
        diagnostics,
        totalCostUsd,
      }
    }
  }

  /* 2 — compiler drops its conformance suite (overwriting any tampering) */
  const writeSuite = () => {
    for (const [rel, content] of Object.entries(spec.conformanceFiles)) {
      const target = path.join(workspace, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content, "utf8")
    }
  }
  writeSuite()

  /* 3 — verification with bounded repair loop */
  const verify = async (): Promise<{ setup: CommandResult[]; check: CommandResult[]; ok: boolean }> => {
    const setup: CommandResult[] = []
    for (const cmd of spec.verification.setup) {
      setup.push(await runCommand(cmd.command, workspace, cmd.name, cmd.timeoutMs))
    }
    const check: CommandResult[] = []
    for (const cmd of spec.verification.check) {
      check.push(await runCommand(cmd.command, workspace, cmd.name, cmd.timeoutMs))
    }
    return { setup, check, ok: setup.every((c) => c.ok) && check.every((c) => c.ok) }
  }

  let verification = await verify()
  let round = 0
  while (!verification.ok && round < repairRounds && !options.verifyOnly) {
    round += 1
    const failure =
      [...verification.setup, ...verification.check].find((c) => !c.ok) ??
      verification.check[verification.check.length - 1]
    const run = await runner.run(spec.repairPrompt(failure), workspace)
    totalCostUsd += run.costUsd ?? 0
    writeSuite() // the suite is compiler truth — always restore it
    verification = await verify()
    repairs.push({ round, run, failure })
    if (run.ok && verification.ok) {
      diagnostics.push(
        diagnostic(
          "AGENT_REPAIRED",
          "info",
          `Shot "${shot}" repaired after ${round} round(s).`,
          { details: { shot, round } },
        ),
      )
    }
  }

  const ok = verification.ok
  if (!ok) {
    const failing = [...verification.setup, ...verification.check].filter((c) => !c.ok)
    diagnostics.push(
      diagnostic(
        "AGENT_VERIFICATION_FAILED",
        "error",
        `Shot "${shot}" failed verification: ${failing.map((f) => f.name).join(", ")} failed.`,
        {
          details: {
            shot,
            failures: failing.map((f) => ({
              name: f.name,
              command: f.command,
              exitCode: f.exitCode,
              output: f.output.slice(-2000),
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
        `Shot "${shot}" passed conformance verification.`,
        { details: { shot, checks: verification.check.map((c) => c.name) } },
      ),
    )
  }

  /* 4 — artifacts with provenance */
  const artifacts = scanArtifacts(workspace, {
    excludeDirs: spec.conformanceDirs ?? ["conformance"],
    generatedBy: "fastapi:implement",
    sourceNodes: spec.specNodeIds,
  })

  return {
    shot,
    workspace,
    ok,
    generate,
    repairs,
    verification,
    artifacts,
    diagnostics,
    totalCostUsd,
  }
}
