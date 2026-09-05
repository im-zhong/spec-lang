/**
 * `spec monitor [run-dir] [--port N]` — the generation monitoring platform.
 *
 * An independent, READ-ONLY observer over the telemetry bus written by
 * `spec generate` (`<runRoot>/events/events.ndjson`, see
 * @spec/execution events.ts) plus a live git snapshot of the shot bare
 * repositories. Never touches the generation itself; telemetry is never
 * evidence.
 *
 * Serves one page + JSON:
 *   GET /          — dashboard (single page, polls /api/state)
 *   GET /api/state — full monitor snapshot (nodes, activity, git, costs)
 */
import { spawnSync } from "node:child_process"
import { readEvents } from "@spec/execution"
import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"

export interface MonitorNode {
  task: string
  status: "running" | "done" | "failed" | "pending"
  round?: number
  headSha?: string
  costUsd?: number
  error?: string
  lastActivity?: { ts: string; activity: string; tool?: string; summary: string; role?: string }
}

export interface AgentLane {
  key: string
  task: string
  role: string
  round: number
  alive: boolean
  /** ISO ts of agent.spawned — the lane's position in launch order. */
  spawnedAt: string
  /** Latest token usage and the measured output rate. */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; outputTokS: number }
  feed: Array<Record<string, unknown>>
  /** The currently-streaming activity, rendered as ONE refreshing line. */
  live?: Record<string, unknown>
}

export interface DagTaskInfo {
  task: string
  status: "running" | "done" | "failed" | "pending"
  dependsOn: string[]
  round?: number
  costUsd?: number
  activity?: string
}

/** Group plan tasks into dependency levels (roots first). Pure. */
export function buildDagLevels(tasks: Array<{ id: string; dependsOn: string[] }>): string[][] {
  const level = new Map<string, number>()
  const depth = (id: string, seen: Set<string>): number => {
    if (level.has(id)) return level.get(id)!
    if (seen.has(id)) return 0 // cycle guard — never expected in a plan
    const deps = tasks.find((t) => t.id === id)?.dependsOn ?? []
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => depth(d, new Set([...seen, id]))))
    level.set(id, value)
    return value
  }
  for (const t of tasks) depth(t.id, new Set())
  const byLevel = new Map<number, string[]>()
  for (const [id, value] of level) byLevel.set(value, [...(byLevel.get(value) ?? []), id].sort())
  return [...byLevel.keys()].sort((a, b) => a - b).map((k) => byLevel.get(k)!)
}

export interface MonitorState {
  runRoot: string
  run?: string
  startedAt?: string
  finishedAt?: string
  ok?: boolean
  costUsd: number
  /** Aggregate token usage across all agents (from agent.result usage). */
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  processAlive: boolean
  nodes: MonitorNode[]
  /** Dependency levels of the full plan (all nodes, colored by status). */
  dag: Array<Array<DagTaskInfo>>
  /** One lane per agent instance (task × role × round), newest first. */
  agents: AgentLane[]
  /** Most recent events, newest last. */
  feed: Array<Record<string, unknown>>
  git: Array<{ sha: string; subject: string }>
}

/** Find the newest run directory under `<repo-parent>/.spec-local/<repo>/`. */
export function discoverLatestRun(): string | undefined {
  const base = path.join(path.dirname(process.cwd()), ".spec-local", path.basename(process.cwd()))
  if (!fs.existsSync(base)) return undefined
  const candidates = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(base, entry.name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
  return candidates[0]
}

function gitLines(gitDir: string, args: string[]): string[] {
  const result = spawnSync("git", ["--git-dir", gitDir, ...args], { encoding: "utf8" })
  if (result.status !== 0) return []
  return result.stdout.split("\n").filter((line) => line.trim() !== "")
}

/** The plan's task graph from the bare repo's immutable plan ref. */
function readPlanTasks(runRoot: string, run: string | undefined): Array<{ id: string; dependsOn: string[] }> {
  if (run === undefined) return []
  for (const entry of fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : []) {
    if (!entry.endsWith(".git")) continue
    // Try versioned refs first (retry runs), then the original v1 ref.
    for (const ref of [`spec/generate/${run}/plan.v3`, `spec/generate/${run}/plan.v2`, `spec/generate/${run}/plan`]) {
      const probe = spawnSync("git", ["--git-dir", path.join(runRoot, entry), "rev-parse", "--verify", ref], { encoding: "utf8" })
      if (probe.status !== 0) continue
      const result = spawnSync("git", ["--git-dir", path.join(runRoot, entry), "show", `${ref}:plan.json`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      if (result.status !== 0) continue
      try {
        const plan = JSON.parse(result.stdout) as { tasks?: Array<{ id?: string; dependsOn?: string[] }> }
        return (plan.tasks ?? []).flatMap((t) => (typeof t.id === "string" ? [{ id: t.id, dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [] }] : []))
      } catch { continue }
    }
    const result = spawnSync("git", ["--git-dir", path.join(runRoot, entry), "show", `spec/generate/${run}/plan:plan.json`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    if (result.status !== 0) continue
    try {
      const plan = JSON.parse(result.stdout) as { tasks?: Array<{ id?: string; dependsOn?: string[] }> }
      return (plan.tasks ?? []).flatMap((t) => (typeof t.id === "string" ? [{ id: t.id, dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [] }] : []))
    } catch {
      continue
    }
  }
  return []
}

/** Full-plan view: every node, colored by status, grouped by dependency level. */
function buildDagView(runRoot: string, run: string | undefined, nodes: Map<string, MonitorNode>): Array<Array<DagTaskInfo>> {
  const tasks = readPlanTasks(runRoot, run)
  if (tasks.length === 0) return []
  return buildDagLevels(tasks).map((level) =>
    level.map((id) => {
      const node = nodes.get(id)
      return {
        task: id,
        status: node?.status ?? "pending",
        dependsOn: tasks.find((t) => t.id === id)?.dependsOn ?? [],
        ...(node?.round !== undefined ? { round: node.round } : {}),
        ...(node?.costUsd !== undefined ? { costUsd: node.costUsd } : {}),
        ...(node?.lastActivity !== undefined
          ? { activity: `[${node.lastActivity.tool ?? node.lastActivity.activity}] ${node.lastActivity.summary.slice(0, 60)}` }
          : {}),
      }
    }),
  )
}

function gitSnapshot(runRoot: string): Array<{ sha: string; subject: string }> {
  const out: Array<{ sha: string; subject: string }> = []
  for (const entry of fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : []) {
    if (!entry.endsWith(".git")) continue
    const bare = path.join(runRoot, entry)
    for (const line of gitLines(bare, ["log", "main", "--first-parent", "--format=%h %s", "-n", "40"]).reverse()) {
      const space = line.indexOf(" ")
      out.push({ sha: line.slice(0, space), subject: line.slice(space + 1) })
    }
  }
  return out
}

/** Aggregate the event log into a dashboard snapshot. */
export function buildMonitorState(runRoot: string): MonitorState {
  const allEvents = readEvents(runRoot)
  // Only consider events from the CURRENT attempt (after the last
  // run.started) — old failed-run markers must not leak into the display.
  const lastStart = allEvents.map((e) => e.kind === "run.started").lastIndexOf(true)
  const events = lastStart >= 0 ? allEvents.slice(lastStart) : allEvents
  const nodes = new Map<string, MonitorNode>()
  const lanes = new Map<string, AgentLane>()
  const usageSamples = new Map<string, Array<{ ts: string; out: number }>>()
  const feed: Array<Record<string, unknown>> = []
  let startedAt: string | undefined
  let finished: { ts: string; ok: boolean; costUsd?: number } | undefined

  for (const event of events) {
    const ts = typeof event.ts === "string" ? event.ts : ""
    const kind = String(event.kind)
    if (kind === "run.started") startedAt = ts
    if (kind === "run.finished") {
      finished = { ts, ok: event.ok === true, costUsd: typeof event.costUsd === "number" ? event.costUsd : undefined }
    }
    if (kind === "node.started") {
      const task = String(event.task)
      const node = nodes.get(task) ?? { task, status: "running" as const }
      node.status = "running"
      nodes.set(task, node)
    }
    if (kind === "node.finished") {
      const task = String(event.task)
      const node = nodes.get(task) ?? { task, status: "done" as const }
      node.status = event.ok === true ? "done" : "failed"
      if (typeof event.headSha === "string") node.headSha = event.headSha
      nodes.set(task, node)
    }
    if (kind === "round.started") {
      const task = String(event.task)
      const node = nodes.get(task) ?? { task, status: "running" as const }
      node.round = typeof event.round === "number" ? event.round : undefined
      node.status = "running"
      nodes.set(task, node)
    }
    if (kind === "agent.result") {
      const task = String(event.task)
      const node = nodes.get(task)
      if (node && typeof event.costUsd === "number") node.costUsd = (node.costUsd ?? 0) + event.costUsd
    }
    if (kind === "agent.spawned") {
      const key = `${String(event.task)}·${String(event.role)}·R${String(event.round)}`
      lanes.set(key, { key, task: String(event.task), role: String(event.role), round: Number(event.round ?? 1), alive: true, spawnedAt: ts, feed: [] })
      usageSamples.set(key, [])
    }
    if (kind === "agent.usage") {
      const key = `${String(event.task)}·${String(event.role)}·R${String(event.round)}`
      const lane = lanes.get(key)
      if (lane !== undefined) {
        const samples = usageSamples.get(key) ?? []
        samples.push({ ts, out: typeof event.outputTokens === "number" ? event.outputTokens : 0 })
        usageSamples.set(key, samples.slice(-10))
        const inTok = typeof event.inputTokens === "number" ? event.inputTokens : 0
        const outTok = typeof event.outputTokens === "number" ? event.outputTokens : 0
        const cacheTok = typeof event.cacheReadTokens === "number" ? event.cacheReadTokens : 0
        let rate = 0
        if (samples.length >= 2) {
          const first = samples[0]!
          const last = samples[samples.length - 1]!
          const seconds = (new Date(last.ts).getTime() - new Date(first.ts).getTime()) / 1000
          // output_tokens is cumulative PER MESSAGE; sum message-final deltas
          // by only counting increases across samples.
          let produced = 0
          let prev = samples[0]!.out
          for (const sample of samples.slice(1)) {
            if (sample.out > prev) produced += sample.out - prev
            else if (sample.out < prev) produced += sample.out // new message counter reset
            prev = sample.out
          }
          rate = seconds > 0 ? Math.round(produced / seconds) : 0
        }
        lane.usage = { inputTokens: inTok, outputTokens: outTok, cacheReadTokens: cacheTok, outputTokS: rate }
      }
    }
    if (kind === "agent.result") {
      const key = `${String(event.task)}·${String(event.role)}·R${String(event.round)}`
      lanes.get(key) && (lanes.get(key)!.alive = false)
    }
    if (kind === "agent.activity") {
      const task = String(event.task)
      const key = `${task}·${String(event.role)}·R${String(event.round)}`
      lanes.get(key)?.feed.push(event)
      const node = nodes.get(task) ?? { task, status: "running" as const }
      node.lastActivity = {
        ts,
        activity: String(event.activity),
        ...(typeof event.tool === "string" ? { tool: event.tool } : {}),
        summary: String(event.summary),
        ...(typeof event.role === "string" ? { role: event.role } : {}),
      }
      nodes.set(task, node)
    }
    if (kind === "agent.activity" || kind === "node.started" || kind === "node.finished" || kind === "round.started" || kind === "round.finished" || kind === "challenge" || kind === "conformance.result") {
      feed.push(event)
    }
  }

  const run = events.find((event) => typeof event.run === "string")?.run
  // NB: the pattern must NOT start with "-" — macOS pgrep eats it as an
  // option and errors, making processAlive permanently false.
  const pgrep = typeof run === "string" ? spawnSync("pgrep", ["-f", `run-id ${run}`], { encoding: "utf8" }) : undefined
  const usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  for (const event of events) {
    if (event.kind !== "agent.result") continue
    const usage = event.usage as Record<string, unknown> | undefined
    if (usage === undefined) continue
    usageTotals.inputTokens += typeof usage.inputTokens === "number" ? usage.inputTokens : 0
    usageTotals.outputTokens += typeof usage.outputTokens === "number" ? usage.outputTokens : 0
    usageTotals.cacheReadTokens += typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : 0
    usageTotals.cacheCreationTokens += typeof usage.cacheCreationTokens === "number" ? usage.cacheCreationTokens : 0
  }
  return {
    runRoot,
    run: typeof run === "string" ? run : undefined,
    startedAt,
    finishedAt: finished?.ts,
    ok: finished?.ok,
    usage: usageTotals,
    costUsd: finished?.costUsd ?? [...nodes.values()].reduce((sum, node) => sum + (node.costUsd ?? 0), 0),
    processAlive: pgrep !== undefined && pgrep.status === 0,
    nodes: [...nodes.values()].sort((left, right) => left.task.localeCompare(right.task)),
    dag: buildDagView(runRoot, typeof run === "string" ? run : undefined, nodes),
    agents: [...lanes.values()]
      // Launch order, newest first: stable (no reshuffle when lanes die)
      // and the running agents — spawned latest — stay on top.
      .sort((left, right) => (right.spawnedAt ?? "").localeCompare(left.spawnedAt ?? ""))
      // Full history, no cap: a 90-minute run is ~3k events (~1.5 MB),
      // parsed in milliseconds on loopback, and the DOM is append-only.
      // (If runs ever grow 100×, the fix is incremental ?since= polling,
      // not a truncating cap.)
      //
      // Live-line derivation: the trailing partial is the live line. For
      // events from generators PREDATING the partial flag (version skew
      // during a live run), a trailing RUN of consecutive same-kind
      // thinking/text events is coalesced the same way — those are 1.5s
      // throttle flushes of one ongoing block, not separate activities.
      .map((lane) => {
        // Generators predating the partial flag emit 1.5s throttle flushes
        // as UNMARKED thinking/text events. Fold EVERY consecutive run of
        // them — anywhere in the lane, not just the tail — into ONE event
        // per run (their chunks concatenate into the block's text), then
        // derive the live line from the trailing run/partial.
        const folded: Array<Record<string, unknown>> = []
        for (const event of lane.feed) {
          if (String(event.summary ?? "").trim() === "") continue
          const streaming = (event.activity === "thinking" || event.activity === "text") && event.tool === undefined
          const previous = folded[folded.length - 1]
          const sameRun = streaming && previous !== undefined && previous.activity === event.activity && previous.tool === undefined
          if (event.partial === true) {
            // Rolling-window flushes overlap (each carries the freshest
            // tail of the same buffer); the LAST one supersedes the rest.
            if (sameRun) previous.summary = event.summary
            else folded.push({ ...event })
            continue
          }
          if (sameRun) {
            if (previous.partial === true) {
              // A COMPLETE event supersedes the rolling-window flushes of
              // the same block: replace it (the complete event carries the
              // full text). Merging into the partial entry instead made the
              // whole block invisible — the renderer skips partials.
              folded[folded.length - 1] = { ...event }
            } else {
              // Old-protocol disjoint chunks concatenate into the block text.
              previous.summary = String(previous.summary ?? "") + " " + String(event.summary ?? "")
            }
            continue
          }
          folded.push({ ...event })
        }
        let live: Record<string, unknown> | undefined
        let end = folded.length
        const last = lane.feed[lane.feed.length - 1]
        if (last !== undefined && last.partial === true) {
          live = last
        } else if (end > 0 && lane.alive) {
          // Only a RUNNING lane has a live line; a finished lane's trailing
          // thinking is history, not an ongoing stream.
          const tail = folded[end - 1]!
          if ((tail.activity === "thinking" || tail.activity === "text") && tail.tool === undefined) {
            live = tail
            end -= 1
          }
        }
        return { ...lane, feed: folded.slice(0, end), ...(live !== undefined ? { live } : {}) }
      }),
    feed: feed.slice(-250),
    git: gitSnapshot(runRoot),
  }
}

export function startMonitorServer(options: { runRoot: string; port: number }): http.Server {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/state") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(buildMonitorState(options.runRoot)))
      return
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(DASHBOARD)
  })
  server.listen(options.port, "127.0.0.1")
  return server
}

const DASHBOARD = `<!doctype html>
<html><head><meta charset="utf-8"><title>spec monitor</title>
<style>
  body{background:#0d1117;color:#c9d1d9;font:13px/1.5 -apple-system,Menlo,monospace;margin:0;padding:16px;max-width:100vw;overflow-x:hidden}
  .card{min-width:0}
  h1{font-size:15px;margin:0 0 4px} .sub{color:#8b949e;margin-bottom:12px}
  .grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;width:100%;box-sizing:border-box}
  .card{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px}
  .card h2{font-size:12px;color:#8b949e;margin:0 0 8px;text-transform:uppercase}
  table{width:100%;border-collapse:collapse}td{padding:3px 6px 3px 0;vertical-align:top}
  .done{color:#3fb950}.running{color:#d29922}.failed{color:#f85149}
  .muted{color:#8b949e}.feed div{padding:1px 0;border-bottom:1px solid #21262d}
  .thinking{color:#a371f7}.tool{color:#58a6ff}.text{color:#c9d1d9}
  .lane{border:1px solid #30363d;border-radius:6px;margin-bottom:10px;background:#0d1117}
  .lane-on{border-color:#d29922}.lane-off{opacity:.55}
  .lane-head{padding:4px 8px;border-bottom:1px solid #21262d;font-size:12px}
  .lane-feed{padding:4px 8px;max-height:420px;overflow:auto;scrollbar-width:thin}
  .lane-feed::-webkit-scrollbar{width:8px}
  .lane-feed::-webkit-scrollbar-thumb{background:#30363d;border-radius:4px}
  .ev{cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .ev::after{content:" ⌄";color:#58a6ff}
  .ev.open{white-space:normal}
  .ev.open::after{content:" ⌃"}
  .ev.open .evfull{display:block}
  .evfull{display:none;white-space:pre-wrap;background:#0a0d12;border-left:2px solid #30363d;margin:2px 0 4px;padding:4px 6px;max-height:300px;overflow:auto;font-size:11px;color:#8b949e}
  .live{padding:3px 8px;border-top:1px dashed #30363d;color:#a371f7;font-size:11px;min-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lane.collapsed .lane-feed{display:none}
  .lane-head{cursor:pointer;user-select:none}
  .lane-head::after{content:"▾";float:right;color:#8b949e}
  .lane.collapsed .lane-head::after{content:"▸"}
  #dag{position:relative;overflow:auto;max-width:100%;max-height:70vh;box-sizing:border-box}
  #dag svg{max-width:none}
  #dag svg{position:absolute;top:0;left:0;pointer-events:none}
  .chip{position:absolute;border:1px solid #30363d;border-radius:5px;padding:2px 6px;width:118px;background:#0d1117;z-index:1;cursor:pointer}
  .chip .nm{font-weight:bold;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .chip .dt{color:#8b949e;font-size:10px;max-width:106px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .chip-selected{border-color:#58a6ff;box-shadow:0 0 0 1px #58a6ff}
  .chip-dimmed{opacity:.2}
  .edge-in{stroke:#58a6ff !important;stroke-width:2;stroke-dasharray:8 4;animation:dash 0.8s linear infinite}
  .edge-out{stroke:#d29922 !important;stroke-width:2;stroke-dasharray:8 4;animation:dash 0.8s linear infinite}
  @keyframes dash{to{stroke-dashoffset:-12}}
  .chip-done{border-color:#238636}.chip-done .nm{color:#3fb950}
  .chip-running{border-color:#d29922}.chip-running .nm{color:#d29922}
  .chip-failed{border-color:#f85149}.chip-failed .nm{color:#f85149}
  .chip-pending{opacity:.55}
  .pulse{color:#d29922;animation:blink 1.2s infinite}
  @keyframes blink{50%{opacity:.3}}
  .banner-ok{background:#12331b;color:#3fb950;padding:8px;border-radius:6px;margin-bottom:12px}
  .banner-bad{background:#3d1214;color:#f85149;padding:8px;border-radius:6px;margin-bottom:12px}
</style></head><body>
<div id="app">loading…</div>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
// Event timestamps are ISO-UTC; always render LOCAL time.
const evTime = (e) => loc(e.startedAt || e.ts);
const fmtDur = (ms) => ms >= 60000 ? Math.round(ms/60000) + "m" + Math.round(ms%60000/1000) + "s" : ms >= 1000 ? (ms/1000).toFixed(1) + "s" : ms + "ms";
const loc = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString("en-GB", { hour12: false }); };
const app = document.getElementById("app");
// Static skeleton built once; every tick only MUTATES text or APPENDS nodes,
// so selections, scroll, and hover survive re-renders.
app.innerHTML =
  '<div id="banner"></div><h1 id="head"></h1><div class="sub" id="sub"></div>' +
  '<div class="grid">' +
  '<div class="card"><h2>DAG（绿=完成 · 黄=进行中 · 灰=未开始）</h2><div id="dag"></div></div>' +
  '<div class="card"><h2>Claude 实例 <span id="laneHint" class="muted" style="font-weight:normal"></span></h2><div id="lanes"></div></div>' +
  '</div>' +
  '<div class="card" style="margin-top:16px"><h2>git main（最新落地在上）</h2><div class="feed" id="git"></div></div>';

const laneEls = new Map();   // key -> {root, feed, head, ids:Set}
const nodeEls = new Map();   // task -> {root, nm, dt, lvl}
const gitIds = new Set();
let dagLaid = false;
let selectedTask = null;
function highlightDag() {
  if (selectedTask === null) {
    for (const [, chip] of nodeEls) {
      chip.root.classList.remove("chip-selected", "chip-dimmed");
      for (const edge of chip.edges) edge.classList.remove("edge-in", "edge-out");
    }
    return;
  }
  const deps = new Set(), dependents = new Set();
  for (const [t, chip] of nodeEls) {
    const depsOn = chip.root.dataset.deps ? chip.root.dataset.deps.split(",") : [];
    if (t === selectedTask) depsOn.forEach(d => deps.add(d));
    if (depsOn.includes(selectedTask)) dependents.add(t);
  }
  for (const [t, chip] of nodeEls) {
    chip.root.classList.toggle("chip-selected", t === selectedTask);
    chip.root.classList.toggle("chip-dimmed", !deps.has(t) && !dependents.has(t) && t !== selectedTask);
  }
  // Precise edge highlighting: only edges where from or to IS the selected node
  const allEdges = document.querySelectorAll("#dag svg path");
  for (const edge of allEdges) {
    edge.classList.remove("edge-in", "edge-out");
    if (edge.dataset.to === selectedTask) edge.classList.add("edge-in");
    else if (edge.dataset.from === selectedTask) edge.classList.add("edge-out");
  }
}

function applyLaneFilter() {
  for (const [key, entry] of laneEls) {
    entry.root.style.display = selectedTask !== null && key.split("·")[0] !== selectedTask ? "none" : "";
  }
}

const fmtTok = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
const evLine = (e) => {
  const t = evTime(e);
  if (e.kind === "agent.activity") return "<div class='ev'><span class='muted'>" + t + "</span> <span class='" + e.activity + "'>[" + (e.tool || e.activity) + "]</span> <span class='evtext'>" + esc(e.summary || "") + (e.durationMs ? " <span class='muted'>[" + fmtDur(e.durationMs) + "]</span>" : "") + "</span></div>";
  if (e.kind === "node.started") return "<div class='ev'><span class='muted'>" + t + "</span> ⟳ <b>" + esc(e.task) + "</b> 启动</div>";
  if (e.kind === "node.finished") return "<div class='ev'><span class='muted'>" + t + "</span> <span class='" + (e.ok ? "done" : "failed") + "'>" + (e.ok ? "✓" : "✗") + " " + esc(e.task) + "</span> " + esc((e.headSha || "").slice(0, 8)) + "</div>";
  if (e.kind === "round.started") return "<div class='ev'><span class='muted'>" + t + "</span> " + esc(e.task) + " 第 " + e.round + " 轮</div>";
  if (e.kind === "round.finished") return "<div class='ev'><span class='muted'>" + t + "</span> " + esc(e.task) + " R" + e.round + " " + (e.approved ? "<span class='done'>通过</span>" : "<span class='failed'>驳回</span>") + "</div>";
  if (e.kind === "challenge") return "<div class='ev'><span class='muted'>" + t + "</span> <span class='failed'>挑战契约 " + esc(e.clause) + "</span></div>";
  return "<div><span class='muted'>" + t + " " + esc(e.kind) + "</span></div>";
};

function ensureLane(a) {
  let entry = laneEls.get(a.key);
  if (entry === undefined) {
    const root = document.createElement("div");
    root.className = "lane";
    root.innerHTML = '<div class="lane-head"></div><div class="lane-feed"></div>';
    const live = document.createElement("div");
    live.className = "live";
    entry = { root, feed: root.querySelector(".lane-feed"), head: root.querySelector(".lane-head"), live, ids: new Set() };
    root.appendChild(live);
    root.addEventListener("click", (event) => {
      if (event.target.closest(".lane-feed")) return // let text selection work
      root.classList.toggle("collapsed")
    })
    laneEls.set(a.key, entry);
    document.getElementById("lanes").prepend(root);
  }
  const usageText = a.usage !== undefined
    ? " <span class='muted'>↑" + fmtTok(a.usage.inputTokens + a.usage.cacheReadTokens) + " ↓" + fmtTok(a.usage.outputTokens) + " · " + a.usage.outputTokS + " t/s</span>"
    : "";
  entry.head.innerHTML =
    (a.alive ? '<span class="pulse">●</span> ' : '<span class="muted">○</span> ') +
    "<b>" + esc(a.task) + "</b> · " + esc(a.role) + " · R" + a.round + usageText;
  // Toggle status classes WITHOUT overwriting className — the "collapsed"
  // state set by the user's click must survive every 2s re-render.
  entry.root.classList.toggle("lane-on", a.alive)
  entry.root.classList.toggle("lane-off", !a.alive);
  return entry;
}

function appendPinned(container, html, id, full) {
  const pinned = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
  const div = document.createElement("div");
  div.innerHTML = html;
  const node = div.firstChild;
  if (id !== undefined) node.dataset.id = id;
  const detail = document.createElement("div");
  detail.className = "evfull";
  detail.textContent = full !== undefined && full !== "" ? full : "";
  node.appendChild(detail);
  node.addEventListener("click", () => node.classList.toggle("open"));
  container.appendChild(node);
  if (pinned) container.scrollTop = container.scrollHeight;
}

async function tick() {
  try {
    const s = await (await fetch("/api/state")).json();
    const mins = s.startedAt ? Math.round((Date.now() - new Date(s.startedAt)) / 60000) : "?";
    const banner = s.finishedAt
      ? '<div class="' + (s.ok ? "banner-ok" : "banner-bad") + '">' + (s.ok ? "✓ conformance passed" : "✗ run failed") + " · $" + (s.costUsd ?? 0).toFixed(2) + "</div>"
      : "";
    const bannerEl = document.getElementById("banner");
    if (bannerEl.innerHTML !== banner) bannerEl.innerHTML = banner;
    const dagAll = s.dag.length > 0 ? s.dag.flat() : s.nodes;
    const dagDone = dagAll.filter(n => n.status === "done").length;
    const head = esc(s.run || s.runRoot) + " · " + (s.processAlive ? "运行中" : "已结束") + " · " + mins + " min · $" + (s.costUsd || 0).toFixed(2) +
      " · 节点 " + dagDone + "/" + dagAll.length + " · " + s.agents.filter(a => a.alive).length + " 个 Claude 并行" +
      " · ↑" + fmtTok(s.usage.inputTokens + s.usage.cacheReadTokens) + " ↓" + fmtTok(s.usage.outputTokens) + " ⚡" + fmtTok(s.usage.cacheReadTokens);
    const headEl = document.getElementById("head");
    if (headEl.textContent !== head) headEl.textContent = head;
    const subEl = document.getElementById("sub");
    if (subEl.textContent !== s.runRoot) subEl.textContent = s.runRoot;

    const dagEl = document.getElementById("dag");
    if (s.dag.length > 0 && !dagLaid) {
      dagLaid = true;
      // Top-down layout: each dependency level is a horizontal row; nodes
      // in a level spread across columns. Fits the half-width column.
      const COL = 128, ROW = 96, W = 118, H = 44, PAD = 4;
      const pos = new Map();
      const rows = s.dag.length;
      const cols = Math.max(...s.dag.map((l) => l.length));
      s.dag.forEach((level, li) => level.forEach((n, ni) => {
        pos.set(n.task, { x: PAD + ni * COL + (cols - level.length) * COL / 2, y: PAD + li * ROW });
      }));
      const width = PAD * 2 + cols * COL - (COL - W), height = PAD * 2 + rows * ROW - (ROW - H);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", width); svg.setAttribute("height", height);
      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      defs.innerHTML = '<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#30363d"/></marker>';
      svg.appendChild(defs);
      const edgeByTarget = new Map();
      for (const level of s.dag) for (const n of level) {
        for (const dep of n.dependsOn) {
          const a = pos.get(dep), b = pos.get(n.task);
          if (!a || !b) continue;
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y - 4;
          const mid = (y1 + y2) / 2;
          path.setAttribute("d", "M" + x1 + "," + y1 + " C" + x1 + "," + mid + " " + x2 + "," + mid + " " + x2 + "," + y2);
          path.setAttribute("fill", "none"); path.setAttribute("stroke", "#30363d");
          path.setAttribute("marker-end", "url(#arr)");
          path.dataset.from = dep;   // source task (for precise highlighting)
          path.dataset.to = n.task; // target task
          svg.appendChild(path);
          edgeByTarget.set(n.task, [...(edgeByTarget.get(n.task) ?? []), path]);
        }
      }
      dagEl.style.width = "100%"; dagEl.style.height = Math.min(height + 24, window.innerHeight * 0.7) + "px";
      dagEl.appendChild(svg);
      for (const [task, pt] of pos) {
        const root = document.createElement("div");
        root.dataset.task = task;
        root.className = "chip chip-pending";
        root.innerHTML = "<div class='nm'></div><div class='dt'></div>";
        root.style.left = pt.x + "px"; root.style.top = pt.y + "px";
        root.addEventListener("click", () => {
          selectedTask = task;
          highlightDag();
          applyLaneFilter();
        });
        root.dataset.deps = (s.dag.flat().find(n => n.task === task)?.dependsOn ?? []).join(",");
        nodeEls.set(task, { root, nm: root.querySelector(".nm"), dt: root.querySelector(".dt"), edges: edgeByTarget.get(task) ?? [] });
        dagEl.appendChild(root);
      }
    }
    for (const level of s.dag) for (const n of level) {
      const chip = nodeEls.get(n.task);
      if (chip === undefined) continue;
      const nm = (n.status === "done" ? "✓ " : n.status === "running" ? "⟳ " : n.status === "failed" ? "✗ " : "") + n.task + (n.round ? " R" + n.round : "");
      if (chip.nm.textContent !== nm) chip.nm.textContent = nm;
      const dt = ((n.activity || "") + (n.costUsd ? " · $" + n.costUsd.toFixed(2) : "")).trim();
      if (chip.dt.textContent !== dt) { chip.dt.textContent = dt; chip.dt.title = dt; }
      const cls = "chip chip-" + n.status;
      if (chip.root.className !== cls) chip.root.className = cls;
      const edgeStroke = n.status === "running" ? "#d29922" : n.status === "done" ? "#238636" : "#30363d";
      for (const edge of chip.edges) {
        if (edge.classList.contains("edge-in") || edge.classList.contains("edge-out")) continue;
        if (edge.getAttribute("stroke") !== edgeStroke) edge.setAttribute("stroke", edgeStroke);
      }
    }

    for (const a of s.agents) { // all lanes — no display cap; finished ones stay compact and collapsible
      const entry = ensureLane(a);
      for (const e of a.feed) {
        if (e.partial === true) continue // rendered as the live line below
        const id = (e.ts || "") + ":" + (e.summary || "").slice(0, 24);
        if (entry.ids.has(id)) continue;
        entry.ids.add(id);
        appendPinned(entry.feed, evLine(e), id, typeof e.full === "string" && e.full !== "" ? e.full : String(e.summary ?? ""));
      }
      const liveEvent = a.live ?? null;
      const liveText = liveEvent === null ? "" : "[" + (liveEvent.activity === "thinking" ? "思考中" : "生成中") + "] " + String(liveEvent.summary || "").slice(-160);
      if (entry.live.textContent !== liveText) { entry.live.textContent = liveText; entry.live.title = liveText; }
      entry.live.style.display = liveEvent === null ? "none" : "";
    }
    const hint = selectedTask !== null ? "· 仅显示 " + selectedTask + " <span id='clearFilter' style='color:#58a6ff;cursor:pointer;text-decoration:underline'>✕ 显示全部</span>" : "· 点击左图节点筛选";
    const hintEl = document.getElementById("laneHint");
    if (hintEl.innerHTML !== hint) hintEl.innerHTML = hint;
    applyLaneFilter();

    const gitEl = document.getElementById("git");
    for (const g of s.git) {
      if (gitIds.has(g.sha)) continue;
      gitIds.add(g.sha);
      const div = document.createElement("div");
      div.innerHTML = "<span class='muted'>" + esc(g.sha) + "</span> " + esc(g.subject);
      div.dataset.sha = g.sha;
      gitEl.appendChild(div);
    }
  } catch (e) { document.getElementById("head").textContent = "monitor 不可达: " + e; }
}
tick(); setInterval(tick, 2000);
</script></body></html>
`
