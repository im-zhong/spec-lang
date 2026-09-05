/**
 * `spec preview <shot-dir>` — live follow mode for a local shot.
 *
 * Local generation lands every node through merge-to-main commits in the
 * shot's bare remote; the shot clone itself stays at bootstrap. Preview
 * closes that gap as an INDEPENDENT observer process (it never touches the
 * orchestrator): poll the remote main, pull each new landing into the
 * clone, sync dependencies when the project files change, and (re)start
 * the generated app on a fixed port the moment app/main.py exists — so the
 * application is watchable while the DAG is still running.
 *
 * Not golden-rule evidence; a viewer for local iteration only.
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { ChildProcess } from "node:child_process"

const APP_LOG = path.join("/tmp", "spec-preview-app.log")

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`)
  }
  return result.stdout.trim()
}

/** Locate the generated backend root (targetDirectory layout: products/<app>/backend). */
export function findBackendDir(shotDir: string): string | null {
  const direct = path.join(shotDir, "app", "main.py")
  if (fs.existsSync(direct)) return shotDir
  const products = path.join(shotDir, "products")
  if (!fs.existsSync(products)) return null
  for (const app of fs.readdirSync(products).sort()) {
    for (const target of ["backend", "app", "."]) {
      const candidate = path.join(products, app, target)
      if (fs.existsSync(path.join(candidate, "app", "main.py"))) return candidate
    }
  }
  return null
}

function dependencyFingerprint(backendDir: string): string | null {
  const files = ["pyproject.toml", "uv.lock"].map((name) => path.join(backendDir, name)).filter((f) => fs.existsSync(f))
  if (files.length === 0) return null
  const hash = createHash("sha256")
  for (const file of files) hash.update(fs.readFileSync(file))
  return hash.digest("hex")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface PreviewOptions {
  shotDir: string
  port: number
  intervalMs: number
  log?: (line: string) => void
}

export async function runPreview(options: PreviewOptions): Promise<void> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const shotDir = path.resolve(options.shotDir)
  const remote = git(shotDir, ["config", "--get", "remote.origin.url"])
  log(`preview: following ${path.basename(remote)} → ${shotDir}`)
  let last = ""
  let lastDeps: string | null = null
  let app: ChildProcess | null = null
  let backendDir: string | null = null

  const stopApp = () => {
    if (app !== null && app.exitCode === null) app.kill("SIGTERM")
    app = null
  }
  process.on("SIGINT", () => {
    stopApp()
    process.exit(0)
  })

  // uvicorn is the viewer's concern, not the generated project's contract;
  // it is injected at run time and never enters the pinned stack.
  const startApp = () => {
    if (backendDir === null) return
    stopApp()
    const out = fs.openSync(APP_LOG, "a")
    app = spawn(
      "uv",
      ["run", "--no-project", "--with", "uvicorn", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(options.port)],
      { cwd: backendDir, detached: false, stdio: ["ignore", out, out] },
    )
    const started = app
    log(`preview: app (re)starting on http://127.0.0.1:${options.port} (pid ${started.pid}, log ${APP_LOG})`)
  }

  while (true) {
    const head = git(shotDir, ["ls-remote", "--heads", "origin", "refs/heads/main"]).split(/\s+/)[0] ?? ""
    if (head !== "" && head !== last) {
      const before = git(shotDir, ["rev-parse", "HEAD"])
      git(shotDir, ["fetch", "origin", "main"])
      git(shotDir, ["merge", "--ff-only", "origin/main"])
      const landed = git(shotDir, ["log", "--oneline", `${before}..${head}`])
      if (landed.trim() === "") {
        log(`preview: main @ ${head.slice(0, 10)}`)
      } else {
        for (const line of landed.split("\n").filter(Boolean)) log(`preview: landed  ${line}`)
      }
      last = head

      const next = findBackendDir(shotDir)
      const deps = next !== null ? dependencyFingerprint(next) : null
      if (next !== null && deps !== null && deps !== lastDeps) {
        log("preview: syncing dependencies (uv sync)")
        const synced = spawnSync("uv", ["sync"], { cwd: next, encoding: "utf8" })
        if (synced.status !== 0) log(`preview: uv sync failed: ${(synced.stderr ?? "").slice(-400)}`)
        lastDeps = deps
      }
      if (next !== backendDir || (next !== null && fs.existsSync(path.join(next, "app", "main.py")))) {
        const hadApp = backendDir !== null && app !== null
        backendDir = next
        if (backendDir !== null && fs.existsSync(path.join(backendDir, "app", "main.py"))) startApp()
        else if (hadApp) log("preview: waiting for app/main.py to appear")
      }
    }
    await sleep(options.intervalMs)
  }
}
