import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parseResultJson } from "../src/runner"
import { normalizeJson, OPENAPI_SNIPPET } from "../src/repeatability"
import { isCompilerWorkspace, MARKER_FILE, prepareWorkspace, scanArtifacts, sha256 } from "../src/artifacts"
import { runCommand } from "../src/orchestrate"

describe("parseResultJson", () => {
  it("parses a clean result payload", () => {
    const payload = parseResultJson(
      '{"is_error":false,"result":"done","session_id":"s1","total_cost_usd":0.5,"num_turns":3}',
    )
    expect(payload).toMatchObject({ is_error: false, result: "done", session_id: "s1" })
  })

  it("skips leading noise and picks the last complete object", () => {
    const noisy = 'some warning\n{"a":1}\n{"is_error":false,"result":"ok"}\n'
    const payload = parseResultJson(noisy)
    expect(payload).toMatchObject({ result: "ok" })
  })

  it("returns undefined for garbage", () => {
    expect(parseResultJson("no json here")).toBeUndefined()
  })
})

describe("artifacts", () => {
  it("hashes files, skips venvs, classifies types, records provenance", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spec-art-"))
    fs.writeFileSync(path.join(tmp, "pyproject.toml"), "[project]\nname='x'\n")
    fs.mkdirSync(path.join(tmp, "app"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "app", "main.py"), "app = 1\n")
    fs.mkdirSync(path.join(tmp, ".venv", "lib"), { recursive: true })
    fs.writeFileSync(path.join(tmp, ".venv", "lib", "junk.py"), "junk")
    const artifacts = scanArtifacts(tmp, {
      generatedBy: "fastapi:implement",
      sourceNodes: ["app:Demo", "entity:User"],
    })
    const paths = artifacts.map((a) => a.path)
    expect(paths).toEqual(["app/main.py", "pyproject.toml"])
    expect(artifacts[0].type).toBe("source")
    expect(artifacts[1].type).toBe("config")
    expect(artifacts[0].contentHash).toBe(sha256("app = 1\n"))
    expect(artifacts[0].generatedBy).toBe("fastapi:implement")
    expect(artifacts[0].sourceNodes).toEqual(["app:Demo", "entity:User"])
  })

  it("prepareWorkspace refuses to wipe foreign directories", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spec-ws-"))
    const foreign = path.join(tmp, "foreign")
    fs.mkdirSync(foreign)
    fs.writeFileSync(path.join(foreign, "important.txt"), "data")
    expect(() => prepareWorkspace(foreign)).toThrow(/refusing to overwrite/)
    expect(fs.readFileSync(path.join(foreign, "important.txt"), "utf8")).toBe("data")
  })

  it("prepareWorkspace wipes only marked workspaces and re-marks them", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spec-ws-"))
    const ws = path.join(tmp, "gen")
    fs.mkdirSync(ws)
    fs.writeFileSync(path.join(ws, MARKER_FILE), "old\n")
    fs.writeFileSync(path.join(ws, "stale.py"), "old")
    prepareWorkspace(ws)
    expect(fs.readdirSync(ws)).toEqual([MARKER_FILE])
    expect(isCompilerWorkspace(ws)).toBe(true)
  })
})

describe("runCommand", () => {
  it("captures output, exit code and success", async () => {
    const ok = await runCommand("echo hello", process.cwd(), "echo")
    expect(ok.ok).toBe(true)
    expect(ok.output).toContain("hello")
    const bad = await runCommand("echo oops >&2; exit 3", process.cwd(), "fail")
    expect(bad.ok).toBe(false)
    expect(bad.exitCode).toBe(3)
    expect(bad.output).toContain("oops")
  })

  it("times out runaway commands", async () => {
    const result = await runCommand("sleep 5", process.cwd(), "slow", 200)
    expect(result.ok).toBe(false)
    expect(result.output).toContain("timed out")
  }, 10_000)
})

describe("repeatability helpers", () => {
  it("normalizeJson extracts the canonical JSON object", () => {
    expect(normalizeJson('noise {"a":1} trailing')).toBe('{"a":1}')
    expect(normalizeJson("nothing")).toBeNull()
  })

  it("the OpenAPI snapshot snippet is deterministic python", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spec-snap-"))
    fs.writeFileSync(path.join(tmp, "snap.py"), OPENAPI_SNIPPET)
    const { execFileSync } = await import("node:child_process")
    expect(() => execFileSync("python3", ["-m", "py_compile", "snap.py"], { cwd: tmp })).not.toThrow()
  })
})
