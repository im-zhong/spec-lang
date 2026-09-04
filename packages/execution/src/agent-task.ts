import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import type { AgentExecutionCheckResult, ResolvedAgentExecutionTask } from "@spec/core"
import { commandFailure, type ProcessResult } from "./process"

export const DEFAULT_AGENT_COMMAND = [
  "claude", "-p", "--output-format", "json", "--safe-mode", "--no-session-persistence",
  "--permission-mode", "acceptEdits",
  "--allowedTools",
  "Read", "Glob", "Grep", "LS", "Edit", "Write",
  "Bash(uv:*)", "Bash(python:*)", "Bash(python3:*)", "Bash(.venv/bin/python:*)",
  "Bash(pytest:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)",
  "Bash(wc:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(mkdir:*)", "Bash(sed:*)",
]

export const DEFAULT_REVIEWER_COMMAND = [
  "claude", "-p", "--output-format", "json", "--safe-mode", "--no-session-persistence",
  "--permission-mode", "plan", "--allowedTools",
  "Read", "Glob", "Grep", "LS", "Bash(uv:*)", "Bash(python:*)", "Bash(python3:*)",
  "Bash(.venv/bin/python:*)", "Bash(pytest:*)", "Bash(ls:*)", "Bash(cat:*)",
  "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(sed:*)",
]

/**
 * How one execution environment invokes the coding agent and shell commands
 * inside a task working directory. A Docker executor wraps both in
 * `docker exec` against a mounted container; a host executor spawns them
 * directly. Everything else — loop protocol, scope audit, acceptance — is
 * environment-independent and lives in executeAgentTask.
 */
export interface AgentTaskRunner {
  agent(command: string[], prompt: string, timeoutMs: number): Promise<ProcessResult>
  shell(command: string, timeoutMs: number): Promise<ProcessResult>
}

export interface AgentTaskCoreOptions {
  agentCommand: string[]
  reviewerAgentCommand: string[]
  timeoutMs: number
}

export interface AgentTaskCoreResult {
  checks: AgentExecutionCheckResult[]
  costUsd?: number
  error?: string
}

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

/**
 * Loop v0.2 challenge protocol: an implementation agent that concludes the
 * frozen contract is defective must answer with exactly one JSON object
 * {"challenge":{"clause":...,"reason":...}} instead of improvising. Parsing
 * mirrors the reviewer verdict: tolerant of fences/prose, strictly shaped.
 */
function contractChallenge(stdout: string): { clause: string; reason: string } | undefined {
  try {
    const envelope = parseAgentEnvelope(stdout)
    if (!envelope) return undefined
    const raw = typeof envelope.result === "string" ? envelope.result : JSON.stringify(envelope)
    const candidate = extractVerdictObject(raw)
    const challenge = candidate?.challenge
    if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)) return undefined
    const clause = (challenge as Record<string, unknown>).clause
    const reason = (challenge as Record<string, unknown>).reason
    if (typeof clause !== "string" || typeof reason !== "string" || !clause.trim() || !reason.trim()) return undefined
    return { clause, reason }
  } catch {
    return undefined
  }
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

/**
 * Environment-independent core of one generation node: compiler materialize
 * writes, the v0.2 implementation/reviewer loop, a plain agent task, and the
 * task's own acceptance commands. Container/host differences are confined to
 * the injected AgentTaskRunner.
 */
export async function executeAgentTask(
  task: ResolvedAgentExecutionTask,
  taskDirectory: string,
  runner: AgentTaskRunner,
  options: AgentTaskCoreOptions,
): Promise<AgentTaskCoreResult> {
  const checks: AgentExecutionCheckResult[] = []
  let costUsd: number | undefined
  let error: string | undefined
  fs.mkdirSync(taskDirectory, { recursive: true })

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
  } else if (task.loop?.schemaVersion === "spec-agent-task-loop/0.2") {
    // Loop v0.2: one implementation agent per round working directly in
    // the task workdir; compiler-generated oracles are the frozen
    // reviewer evidence; a contract challenge aborts as a spec defect.
    let feedback = ""
    let approved = false
    costUsd = 0
    for (let round = 1; round <= task.loop.maxRounds; round++) {
      const shared = `\n\n# Frozen node context\nTask: ${task.id}\nRound: ${round}/${task.loop.maxRounds}\n` +
        (feedback ? `Reviewer feedback from the prior round:\n${feedback}\n` : "This is the first round.\n")
      const writerPrompt = `${task.loop.implementation.instruction}${shared}\nYou own only: ${task.loop.implementation.scope.join(", ")}.`
      const before = snapshot(taskDirectory)
      const writer = await runner.agent(options.agentCommand, writerPrompt, options.timeoutMs)
      checks.push({ name: `generation/loop/${round}/implementation`, status: writer.ok ? "success" : "failure" })
      costUsd += agentCost(writer.stdout)
      if (!writer.ok) {
        error = commandFailure(writer).message
        break
      }
      const challenge = contractChallenge(writer.stdout)
      if (challenge) {
        checks.push({ name: `generation/loop/${round}/challenge`, status: "failure" })
        error = `SPEC_CONTRACT_CHALLENGED: task ${task.id} round ${round} rejected clause ${JSON.stringify(challenge.clause)}: ${challenge.reason} The specification is defective — fix the spec/blueprint and regenerate; do not retry.`
        break
      }
      const writes = changedPaths(before, snapshot(taskDirectory)).filter((file) => !isToolArtifact(file))
      const allowed = new Set(roleScope(task, task.loop.implementation.scope))
      const illegal = writes.filter((file) => !allowed.has(file))
      if (illegal.length > 0) {
        error = `implementation agent wrote outside its declared scope: ${illegal.join(", ")}`
        break
      }
      const testEvidence: string[] = []
      for (const command of task.loop.reviewer.commands) {
        const result = await runner.shell(command, options.timeoutMs)
        testEvidence.push(`$ ${command}\nexit=${result.exitCode}\n${result.stdout}\n${result.stderr}`)
      }
      const reviewPrompt = `${task.loop.reviewer.instruction}${shared}
Review the implementation against the frozen node contract and its clause table. The machine evidence is:
${testEvidence.join("\n\n")}
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.`
      const beforeReviewer = snapshot(taskDirectory)
      const review = await runner.agent(options.reviewerAgentCommand, reviewPrompt, options.timeoutMs)
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
        const tail = review.stdout.length > 2_000 ? `…${review.stdout.slice(-2_000)}` : review.stdout
        error = `reviewer for ${task.id} round ${round} returned no structured verdict; reviewer output: ${tail}`
        break
      }
      if (verdict.approved) {
        approved = true
        break
      }
      feedback = verdict.feedback || "Reviewer rejected the round without actionable feedback. Re-check the complete clause table."
    }
    if (!error && !approved) error = `agent loop for ${task.id} exhausted ${task.loop.maxRounds} rounds without approval`
  } else {
    const agent = await runner.agent(options.agentCommand, task.instruction, options.timeoutMs)
    checks.push({ name: "generation/agent", status: agent.ok ? "success" : "failure" })
    if (!agent.ok) error = commandFailure(agent).message
    if (agent.ok) costUsd = agentCost(agent.stdout)
  }

  if (!error) {
    for (let index = 0; index < task.acceptance.commands.length; index++) {
      const command = task.acceptance.commands[index]
      const result = await runner.shell(command, options.timeoutMs)
      checks.push({ name: `generation/acceptance/${index + 1}`, status: result.ok ? "success" : "failure" })
      if (!result.ok) {
        error = commandFailure(result).message
        break
      }
    }
  }

  return { checks, costUsd, ...(error ? { error } : {}) }
}
