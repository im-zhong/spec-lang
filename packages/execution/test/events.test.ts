import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  openEventLog,
  parsePartialDelta,
  parseTokenUpdate,
  parseAgentResultLine,
  parseAgentStreamLine,
  readEvents,
} from "../src/events"

const SAMPLE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-5" }),
  JSON.stringify({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "  先查 router_registry 的形状\n再决定装配顺序  " },
  ] } }),
  JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", name: "Edit", input: { file_path: "app/main.py", new_string: "..." } },
  ] } }),
  JSON.stringify({ type: "assistant", message: { content: [
    { type: "text", text: "骨架完成" },
  ] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s1", total_cost_usd: 0.42, num_turns: 18, duration_ms: 61000, result: "done" }),
]

describe("agent stream telemetry", () => {
  it("distills thinking, tool calls, and text from stream-json lines", () => {
    const thinking = parseAgentStreamLine(SAMPLE_LINES[1]!)
    expect(thinking?.kind).toBe("agent.activity")
    if (thinking?.kind === "agent.activity") {
      expect(thinking.activity).toBe("thinking")
      expect(thinking.summary).toContain("router_registry")
    }
    const tool = parseAgentStreamLine(SAMPLE_LINES[2]!)
    if (tool?.kind === "agent.activity") {
      expect(tool.activity).toBe("tool")
      expect(tool.tool).toBe("Edit")
      expect(tool.summary).toContain("app/main.py")
    }
    const text = parseAgentStreamLine(SAMPLE_LINES[3]!)
    if (text?.kind === "agent.activity") expect(text.summary).toBe("骨架完成")
    // system lines carry nothing interesting
    expect(parseAgentStreamLine(SAMPLE_LINES[0]!)).toBeUndefined()
    // tool RESULTS surface as [result] activity (oracle output visibility)
    const toolResult = parseAgentStreamLine(SAMPLE_LINES[4]!)
    if (toolResult?.kind === "agent.activity") {
      expect(toolResult.tool).toBe("result")
      expect(toolResult.summary).toBe("ok")
    }
    expect(parseAgentStreamLine("not json")).toBeUndefined()
  })

  it("parses partial-message deltas (thinking/text) and ignores the rest", () => {
    // verified against the real CLI: delta is an object inside content_block_delta
    const think = parsePartialDelta(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "先看" } } }))
    expect(think).toEqual({ kind: "thinking", text: "先看" })
    const text = parsePartialDelta(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } } }))
    expect(text).toEqual({ kind: "text", text: "ok" })
    expect(parsePartialDelta(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "x" } } }))).toBeUndefined()
    expect(parsePartialDelta(JSON.stringify({ type: "stream_event", event: { type: "message_start" } }))).toBeUndefined()
    expect(parsePartialDelta(SAMPLE_LINES[1]!)).toBeUndefined()
    expect(parsePartialDelta("garbage")).toBeUndefined()
  })

  it("extracts the final result envelope and truncates long snippets", () => {
    const envelope = parseAgentResultLine(SAMPLE_LINES[5]!)
    expect(envelope?.type).toBe("result")
    expect(envelope?.total_cost_usd).toBe(0.42)
    expect(parseAgentResultLine(SAMPLE_LINES[1]!)).toBeUndefined()
    const long = parseAgentStreamLine(JSON.stringify({ type: "assistant", message: { content: [
      { type: "text", text: "x".repeat(1000) },
    ] } }))
    if (long?.kind === "agent.activity") expect(long.summary.length).toBeLessThanOrEqual(402)
  })

  it("round-trips events through the NDJSON log (and never throws)", () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spec-events-"))
    const log = openEventLog(runRoot, { run: "run-x", shot: "shot-1" })
    log.emit({ kind: "run.started", run: "run-x", shots: ["shot-1"] })
    log.emit({ kind: "node.started", task: "project" })
    log.emit({ kind: "agent.activity", task: "project", round: 1, role: "implementation", activity: "tool", tool: "Write", summary: "Write pyproject.toml" })
    const events = readEvents(runRoot)
    expect(events.map((event) => event.kind)).toEqual(["run.started", "node.started", "agent.activity"])
    expect(events[2]).toMatchObject({ run: "run-x", shot: "shot-1", task: "project" })
    // disabled log (no run root) is a no-op sink
    const off = openEventLog(undefined, { run: "r" })
    expect(() => off.emit({ kind: "log", message: "x" })).not.toThrow()
  })
})

describe("token usage telemetry", () => {
  it("parses message_delta usage (verified shape)", () => {
    const line = JSON.stringify({ type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 28978, output_tokens: 44, cache_read_input_tokens: 128 } } })
    expect(parseTokenUpdate(line)).toEqual({ inputTokens: 28978, outputTokens: 44, cacheReadTokens: 128 })
    expect(parseTokenUpdate(JSON.stringify({ type: "stream_event", event: { type: "message_start", usage: { input_tokens: 0, output_tokens: 0 } } }))).toBeUndefined()
    expect(parseTokenUpdate("garbage")).toBeUndefined()
  })
})
