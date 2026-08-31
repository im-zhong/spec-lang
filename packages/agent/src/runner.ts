/**
 * Claude Code agent runner.
 *
 * Drives the `claude` CLI headlessly (`claude -p`) inside a generation
 * workspace: the agent reads the deterministic prompt produced by the
 * traditional compiler half and writes code with its file tools.
 *
 * The runner is deliberately thin — prompts, verification and grading all
 * live with the compiler. The agent is a code-writing engine, nothing more.
 */
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

export interface AgentRunnerOptions {
  /** Claude CLI binary; default "claude". */
  cli?: string
  model?: string
  maxTurns?: number
  permissionMode?: string
  /** Tool allowlist for headless runs. */
  allowedTools?: string[]
  /** Extra env for the child process. */
  env?: Record<string, string>
  /** Overall wall-clock budget per run, ms (default 45 min). */
  timeoutMs?: number
  /** When set, child stderr is teed here for post-mortem debugging. */
  stderrLogFile?: string
}

export interface AgentRunResult {
  ok: boolean
  sessionId?: string
  costUsd?: number
  durationMs?: number
  turns?: number
  resultText?: string
  error?: string
  /** Raw parsed `--output-format json` payload. */
  raw?: Record<string, unknown>
}

export const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "LS",
  "Edit",
  "Write",
  "Bash(uv:*)",
  "Bash(python:*)",
  "Bash(python3:*)",
  "Bash(.venv/bin/python:*)",
  "Bash(pytest:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(grep:*)",
  "Bash(find:*)",
  "Bash(mkdir:*)",
  "Bash(sed:*)",
]

export class ClaudeCodeAgentRunner {
  readonly model?: string
  private readonly options: AgentRunnerOptions

  constructor(options: AgentRunnerOptions = {}) {
    this.options = options
    this.model = options.model
  }

  /** Run one prompt in the workspace. Never throws — failures are results. */
  run(prompt: string, cwd: string): Promise<AgentRunResult> {
    const {
      cli = "claude",
      model,
      maxTurns = 60,
      permissionMode = "acceptEdits",
      allowedTools = DEFAULT_ALLOWED_TOOLS,
      env,
      timeoutMs = 45 * 60_000,
      stderrLogFile,
    } = this.options

    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      permissionMode,
      "--max-turns",
      String(maxTurns),
    ]
    if (model) args.push("--model", model)
    if (allowedTools.length > 0) args.push("--allowedTools", ...allowedTools)

    return new Promise<AgentRunResult>((resolve) => {
      const child = spawn(cli, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      })

      let stdout = ""
      let stderr = ""
      let settled = false

      const timer = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL")
          settle({ ok: false, error: `agent run timed out after ${timeoutMs}ms` })
        }
      }, timeoutMs)

      const settle = (result: AgentRunResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
        if (stderrLogFile) {
          try {
            fs.appendFileSync(stderrLogFile, chunk.toString())
          } catch {
            // diagnostics only — never fail the run for logging
          }
        }
      })
      child.on("error", (err) => {
        settle({ ok: false, error: `failed to launch "${cli}": ${err.message}` })
      })
      child.on("close", (code) => {
        const payload = parseResultJson(stdout)
        if (!payload) {
          settle({
            ok: false,
            error: `agent exited with code ${code} and unparseable output${stderr ? `: ${stderr.slice(-2000)}` : ""}`,
          })
          return
        }
        const isError = payload.is_error === true || code !== 0
        settle({
          ok: !isError,
          sessionId: typeof payload.session_id === "string" ? payload.session_id : undefined,
          costUsd: typeof payload.total_cost_usd === "number" ? payload.total_cost_usd : undefined,
          durationMs: typeof payload.duration_ms === "number" ? payload.duration_ms : undefined,
          turns: typeof payload.num_turns === "number" ? payload.num_turns : undefined,
          resultText: typeof payload.result === "string" ? payload.result : undefined,
          error: isError ? String(payload.result ?? `exit code ${code}`) : undefined,
          raw: payload,
        })
      })

      child.stdin.write(prompt)
      child.stdin.end()
    })
  }
}

/** Parse the trailing JSON object from CLI output ( tolerate leading noise). */
export function parseResultJson(stdout: string): Record<string, unknown> | undefined {
  const start = stdout.indexOf("{")
  if (start === -1) return undefined
  const candidates = [stdout.slice(start)]
  // If multiple JSON objects were printed, prefer the last complete one.
  const last = stdout.lastIndexOf("\n{")
  if (last > start) candidates.unshift(stdout.slice(last + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
    } catch {
      try {
        const parsed = JSON.parse(candidate.trim())
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
      } catch {
        // keep trying
      }
    }
  }
  return undefined
}
