import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { openEventLog } from "@spec/execution"
import { buildDagLevels, buildMonitorState, startMonitorServer } from "../packages/cli/src/monitor"

async function get(port: number, url: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: url }, (response) => {
      let body = ""
      response.on("data", (chunk) => (body += chunk))
      response.on("end", () => resolve(body))
    }).on("error", reject)
  })
}

describe("spec monitor", () => {
  it("aggregates a run snapshot from the event log", () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spec-monitor-"))
    const log = openEventLog(runRoot, { run: "smoke-x", shot: "shot-1" })
    log.emit({ kind: "run.started", run: "smoke-x", shots: ["shot-1"] })
    log.emit({ kind: "node.started", task: "router:Venue" })
    log.emit({ kind: "round.started", task: "router:Venue", round: 1 })
    log.emit({ kind: "agent.spawned", task: "router:Venue", round: 1, role: "implementation", command: "claude …" })
    log.emit({ kind: "agent.spawned", task: "router:Booking", round: 1, role: "implementation", command: "claude …" })
    log.emit({ kind: "agent.activity", task: "router:Venue", round: 1, role: "implementation", activity: "tool", tool: "Edit", summary: "app/routers/venue.py" })
    log.emit({ kind: "agent.activity", task: "router:Booking", round: 1, role: "implementation", activity: "thinking", summary: "先看 guard" })
    log.emit({ kind: "agent.result", task: "router:Venue", round: 1, role: "implementation", ok: true, costUsd: 0.3, turns: 12 })
    log.emit({ kind: "round.finished", task: "router:Venue", round: 1, approved: true })
    log.emit({ kind: "node.finished", task: "router:Venue", ok: true, headSha: "ab12cd34" })
    log.emit({ kind: "node.started", task: "router:Booking" })
    const state = buildMonitorState(runRoot)
    const venue = state.nodes.find((node) => node.task === "router:Venue")
    expect(venue).toMatchObject({ status: "done", round: 1, headSha: "ab12cd34", costUsd: 0.3 })
    expect(venue?.lastActivity).toMatchObject({ tool: "Edit", summary: "app/routers/venue.py" })
    expect(state.nodes.find((node) => node.task === "router:Booking")?.status).toBe("running")
    expect(state.run).toBe("smoke-x")
    expect(state.feed.length).toBeGreaterThanOrEqual(6)
    // per-instance lanes: two parallel agents, one activity each
    const venueLane = state.agents.find((lane) => lane.task === "router:Venue")
    const bookingLane = state.agents.find((lane) => lane.task === "router:Booking")
    expect(venueLane?.feed).toHaveLength(1)
    expect(bookingLane?.feed[0]).toMatchObject({ activity: "thinking" })
    // Venue's agent.result (emitted later in the fixture) closed its lane;
    // Booking's agent is still running.
    expect(venueLane?.alive).toBe(false)
    expect(state.agents.filter((lane) => lane.alive)).toHaveLength(1)
  })

  it("serves the dashboard and the state API", async () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spec-monitor-"))
    openEventLog(runRoot, { run: "smoke-y", shot: "shot-1" })
      .emit({ kind: "node.started", task: "project" })
    const server = startMonitorServer({ runRoot, port: 0 })
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    if (typeof address !== "object" || address === null) throw new Error("no address")
    const port = address.port
    try {
      const page = await get(port, "/")
      expect(page).toContain("spec monitor")
      const state = JSON.parse(await get(port, "/api/state")) as { nodes: Array<{ task: string }> }
      expect(state.nodes.map((node) => node.task)).toContain("project")
    } finally {
      server.close()
    }
  })
})

describe("spec monitor DAG levels", () => {
  it("groups plan tasks into dependency levels, roots first", () => {
    const levels = buildDagLevels([
      { id: "conformance", dependsOn: ["router-A", "router-B"] },
      { id: "project", dependsOn: [] },
      { id: "models", dependsOn: ["project"] },
      { id: "router-A", dependsOn: ["models"] },
      { id: "router-B", dependsOn: ["models"] },
    ])
    expect(levels).toEqual([
      ["project"],
      ["models"],
      ["router-A", "router-B"],
      ["conformance"],
    ])
  })
})
