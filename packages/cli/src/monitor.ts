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

export interface MonitorState {
  runRoot: string
  run?: string
  startedAt?: string
  finishedAt?: string
  ok?: boolean
  costUsd: number
  processAlive: boolean
  nodes: MonitorNode[]
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
  const events = readEvents(runRoot)
  const nodes = new Map<string, MonitorNode>()
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
    if (kind === "agent.activity") {
      const task = String(event.task)
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
  const pgrep = typeof run === "string" ? spawnSync("pgrep", ["-f", `--run-id ${run}`], { encoding: "utf8" }) : undefined
  return {
    runRoot,
    run: typeof run === "string" ? run : undefined,
    startedAt,
    finishedAt: finished?.ts,
    ok: finished?.ok,
    costUsd: finished?.costUsd ?? [...nodes.values()].reduce((sum, node) => sum + (node.costUsd ?? 0), 0),
    processAlive: pgrep !== undefined && pgrep.status === 0,
    nodes: [...nodes.values()].sort((left, right) => left.task.localeCompare(right.task)),
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
  body{background:#0d1117;color:#c9d1d9;font:13px/1.5 -apple-system,Menlo,monospace;margin:0;padding:16px}
  h1{font-size:15px;margin:0 0 4px} .sub{color:#8b949e;margin-bottom:12px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px}
  .card h2{font-size:12px;color:#8b949e;margin:0 0 8px;text-transform:uppercase}
  table{width:100%;border-collapse:collapse}td{padding:3px 6px 3px 0;vertical-align:top}
  .done{color:#3fb950}.running{color:#d29922}.failed{color:#f85149}
  .muted{color:#8b949e}.feed div{padding:1px 0;border-bottom:1px solid #21262d}
  .thinking{color:#a371f7}.tool{color:#58a6ff}.text{color:#c9d1d9}
  .banner-ok{background:#12331b;color:#3fb950;padding:8px;border-radius:6px;margin-bottom:12px}
  .banner-bad{background:#3d1214;color:#f85149;padding:8px;border-radius:6px;margin-bottom:12px}
</style></head><body>
<div id="app">loading…</div>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function tick() {
  try {
    const s = await (await fetch("/api/state")).json();
    const mins = s.startedAt ? Math.round((Date.now() - new Date(s.startedAt)) / 60000) : "?";
    const banner = s.finishedAt
      ? '<div class="' + (s.ok ? "banner-ok" : "banner-bad") + '">' + (s.ok ? "✓ conformance passed" : "✗ run failed") + " · $" + (s.costUsd ?? 0).toFixed(2) + "</div>"
      : "";
    const nodes = s.nodes.map(n =>
      "<tr><td class='" + n.status + "'>" + (n.status === "done" ? "✓" : n.status === "running" ? "⟳" : "✗") + " " + esc(n.task) +
      (n.round ? " <span class='muted'>R" + n.round + "</span>" : "") + "</td><td>" +
      (n.lastActivity ? "<span class='" + n.lastActivity.activity + "'>" + (n.lastActivity.tool || n.lastActivity.activity) + "</span> " + esc(n.lastActivity.summary.slice(0, 90)) : "") +
      "</td><td class='muted'>" + (n.costUsd ? "$" + n.costUsd.toFixed(2) : "") + "</td></tr>").join("");
    const feed = s.feed.slice(-80).reverse().map(e => {
      const t = (e.ts || "").slice(11, 19);
      if (e.kind === "agent.activity") return "<div><span class='muted'>" + t + " " + esc(e.task) + " R" + e.round + "</span> <span class='" + e.activity + "'>[" + (e.tool || e.activity) + "]</span> " + esc((e.summary || "").slice(0, 110)) + "</div>";
      if (e.kind === "node.started") return "<div><span class='muted'>" + t + "</span> ⟳ <b>" + esc(e.task) + "</b> 启动</div>";
      if (e.kind === "node.finished") return "<div><span class='muted'>" + t + "</span> <span class='" + (e.ok ? "done" : "failed") + "'>" + (e.ok ? "✓" : "✗") + " " + esc(e.task) + "</span> " + esc((e.headSha || "").slice(0, 8)) + "</div>";
      if (e.kind === "round.started") return "<div><span class='muted'>" + t + "</span> " + esc(e.task) + " 第 " + e.round + " 轮</div>";
      if (e.kind === "round.finished") return "<div><span class='muted'>" + t + "</span> " + esc(e.task) + " R" + e.round + " " + (e.approved ? "<span class='done'>通过</span>" : "<span class='failed'>驳回</span>") + "</div>";
      if (e.kind === "challenge") return "<div><span class='muted'>" + t + "</span> <span class='failed'>挑战契约 " + esc(e.clause) + "</span></div>";
      return "<div><span class='muted'>" + t + " " + esc(e.kind) + "</span></div>";
    }).join("");
    const git = s.git.slice(-25).reverse().map(g => "<div><span class='muted'>" + esc(g.sha) + "</span> " + esc(g.subject) + "</div>").join("");
    document.getElementById("app").innerHTML = banner +
      "<h1>" + esc(s.run || s.runRoot) + " · " + (s.processAlive ? "运行中" : "已结束") + " · " + mins + " min · $" + (s.costUsd || 0).toFixed(2) + " · 节点 " + s.nodes.filter(n => n.status === "done").length + "/" + s.nodes.length + "</h1>" +
      '<div class="sub">' + esc(s.runRoot) + "</div>" +
      '<div class="grid"><div class="card"><h2>DAG 节点</h2><table>' + nodes + "</table></div>" +
      '<div class="card"><h2>活动流</h2><div class="feed">' + (feed || "暂无事件") + "</div></div></div>" +
      '<div class="card" style="margin-top:16px"><h2>git main（最新落地在上）</h2><div class="feed">' + (git || "暂无提交") + "</div></div>";
  } catch (e) { document.getElementById("app").textContent = "monitor 不可达: " + e; }
}
tick(); setInterval(tick, 2000);
</script></body></html>
`
