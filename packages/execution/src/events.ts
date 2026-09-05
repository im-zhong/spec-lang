/**
 * Generation event bus — operational telemetry, never evidence.
 *
 * Producers (the agent loop, the orchestrator) append NDJSON events to a
 * run-local file; consumers (`spec monitor`) tail it. Append failures are
 * swallowed by design: losing telemetry must never fail a generation, and
 * the golden-rule judgment continues to live exclusively in git refs and
 * oracle/conformance output — never here.
 *
 * `agent.*` events are distilled from `claude -p --output-format
 * stream-json --verbose`: each stdout line is one CLI event; we keep only
 * what a human wants to watch (thinking snippets, tool calls, results) and
 * truncate aggressively.
 */
import * as fs from "node:fs"
import * as path from "node:path"

export const SNIPPET_LIMIT = 400

export type GenerationEvent =
  | { kind: "run.started"; run: string; shots: string[] }
  | { kind: "run.finished"; run: string; ok: boolean; costUsd?: number }
  | { kind: "node.started"; task: string }
  | { kind: "node.finished"; task: string; ok: boolean; headSha?: string; error?: string }
  | { kind: "round.started"; task: string; round: number }
  | { kind: "round.finished"; task: string; round: number; approved: boolean }
  | { kind: "agent.spawned"; task: string; round: number; role: "implementation" | "reviewer"; command: string }
  | { kind: "agent.activity"; task: string; round: number; role: "implementation" | "reviewer"; activity: "thinking" | "tool" | "text"; tool?: string; summary: string }
  | { kind: "agent.result"; task: string; round: number; role: "implementation" | "reviewer"; ok: boolean; turns?: number; costUsd?: number; durationMs?: number }
  | { kind: "challenge"; task: string; clause?: string }
  | { kind: "conformance.result"; ok: boolean; output?: string }
  | { kind: "log"; message: string }

/** Distilled from one `stream-json` stdout line; `undefined` = not interesting. */
export function parseAgentStreamLine(line: string): GenerationEvent | undefined {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (parsed.type === "user") {
    // Tool RESULTS: the most valuable live signal after the call itself —
    // oracle/pytest output becomes visible while the loop runs.
    const message = parsed.message as { content?: unknown } | undefined
    const blocks = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : []
    let last: string | undefined
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const content = block.content
        last = typeof content === "string" ? content : block.contentIsArray ? undefined : typeof (content as { text?: string })?.text === "string" ? (content as { text: string }).text : undefined
      }
    }
    return last === undefined ? undefined : { kind: "agent.activity", task: "", round: 0, role: "implementation", activity: "tool", tool: "result", summary: truncate(last) }
  }
  if (parsed.type === "assistant") {
    const message = parsed.message as { content?: unknown } | undefined
    const blocks = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : []
    // Prefer the LAST interesting block of the turn (thinking precedes tool
    // use; the tool call is the more actionable thing to show).
    let event: GenerationEvent | undefined
    for (const block of blocks) {
      if (block.type === "thinking" && typeof block.thinking === "string") {
        event = { kind: "agent.activity", task: "", round: 0, role: "implementation", activity: "thinking", summary: truncate(block.thinking) }
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        event = { kind: "agent.activity", task: "", round: 0, role: "implementation", activity: "tool", tool: block.name, summary: truncate(toolSummary(block.name, block.input)) }
      } else if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
        event = { kind: "agent.activity", task: "", round: 0, role: "implementation", activity: "text", summary: truncate(block.text) }
      }
    }
    return event
  }
  return undefined
}

/** A partial-message delta from --include-partial-messages streams. */
export function parsePartialDelta(line: string): { kind: "thinking" | "text"; text: string } | undefined {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (parsed.type !== "stream_event") return undefined
  // Real shape (verified against the CLI): the delta rides a
  // content_block_delta event as an OBJECT — {type: text_delta, text} or
  // {type: thinking_delta, thinking}.
  const event = parsed.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } } | undefined
  if (event?.type !== "content_block_delta" || event.delta === undefined) return undefined
  if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
    return { kind: "text", text: event.delta.text }
  }
  if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") {
    return { kind: "thinking", text: event.delta.thinking }
  }
  return undefined
}

/** The final `result` payload of a stream (same shape as --output-format json). */
export function parseAgentResultLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>
    if (parsed.type === "result") return parsed
  } catch {
    return undefined
  }
  return undefined
}

function toolSummary(name: string, input: unknown): string {
  const record = input as Record<string, unknown> | undefined
  const prime =
    typeof record?.file_path === "string" ? record.file_path :
    typeof record?.path === "string" ? record.path :
    typeof record?.command === "string" ? record.command :
    typeof record?.pattern === "string" ? record.pattern :
    typeof record?.prompt === "string" ? record.prompt :
    undefined
  return prime === undefined ? name : `${name} ${prime}`
}

function truncate(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > SNIPPET_LIMIT ? `${flat.slice(0, SNIPPET_LIMIT)}…` : flat
}

export interface EventLog {
  /** Fire-and-forget append; never throws. */
  emit(event: GenerationEvent): void
}

/** Append-only NDJSON event log under `<runRoot>/events/events.ndjson`. */
export function openEventLog(runRoot: string | undefined, meta: { run: string; shot?: string }): EventLog {
  if (runRoot === undefined) {
    return { emit: () => {} }
  }
  const directory = path.join(runRoot, "events")
  const file = path.join(directory, "events.ndjson")
  try {
    fs.mkdirSync(directory, { recursive: true })
  } catch {
    return { emit: () => {} }
  }
  return {
    emit(event: GenerationEvent) {
      try {
        fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), run: meta.run, ...(meta.shot !== undefined ? { shot: meta.shot } : {}), ...event })}\n`)
      } catch {
        // telemetry only — never fail a generation for logging
      }
    },
  }
}

/** Read every event line (malformed lines are skipped). */
export function readEvents(runRoot: string): Array<Record<string, unknown>> {
  const file = path.join(runRoot, "events", "events.ndjson")
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}
