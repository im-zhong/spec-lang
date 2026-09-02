import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildClaudeArgs, parseResultJson } from "../src/runner"
import { normalizeJson, OPENAPI_SNIPPET } from "../src/repeatability"
import { isCompilerWorkspace, MARKER_FILE, prepareWorkspace, scanArtifacts, sha256 } from "../src/artifacts"
import { runCommand } from "../src/orchestrate"
import { AgentHarness, schedule, type HarnessTask } from "../src/harness"
import { createGitHubGenerationPlan } from "../src/github-generation"
import type { AgentRunResult, ClaudeCodeAgentRunner } from "../src/runner"

describe("parseResultJson", () => {
  it("uses Claude Code defaults unless overrides are explicit", () => {
    const defaults = buildClaudeArgs()
    expect(defaults.slice(0, 5)).toEqual([
      "-p", "--output-format", "json", "--permission-mode", "acceptEdits",
    ])
    expect(defaults).not.toContain("--model")
    expect(defaults).not.toContain("--max-turns")
    expect(defaults).toContain("--allowedTools")
    const overridden = buildClaudeArgs({ model: "custom", maxTurns: 12 })
    expect(overridden).toContain("custom")
    expect(overridden).toContain("12")
  })
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

describe("agent harness", () => {
  /** Fake runner: records prompts, writes one file per task. */
  function fakeRunner(
    handlers: Record<string, (cwd: string) => void>,
  ): ClaudeCodeAgentRunner {
    const seen: string[] = []
    const runner = {
      seen,
      run: async (prompt: string, cwd: string): Promise<AgentRunResult> => {
        seen.push(prompt)
        for (const [marker, handler] of Object.entries(handlers)) {
          if (prompt.includes(`# Task: ${marker}`)) {
            handler(cwd)
            return { ok: true, resultText: `did ${marker}` }
          }
        }
        return { ok: false, error: `no handler for prompt: ${prompt.slice(0, 60)}` }
      },
    }
    return runner as unknown as ClaudeCodeAgentRunner
  }

  const tasks: HarnessTask[] = [
    { id: "app", dependsOn: ["router:b", "router:a"], scope: ["app/main.py"], prompt: "# Task: app\n" },
    { id: "router:a", dependsOn: ["models"], scope: ["app/routers/a.py"], prompt: "# Task: router:a\n" },
    { id: "router:b", dependsOn: ["models"], scope: ["app/routers/b.py"], prompt: "# Task: router:b\n" },
    { id: "models", dependsOn: [], scope: ["app/models.py"], prompt: "# Task: models\n" },
  ]

  it("schedule is a deterministic topological order", () => {
    const order = schedule(tasks).map((t) => t.id)
    expect(order.indexOf("models")).toBeLessThan(order.indexOf("router:a"))
    expect(order.indexOf("models")).toBeLessThan(order.indexOf("router:b"))
    expect(order.indexOf("router:a")).toBeLessThan(order.indexOf("app"))
    expect(order.indexOf("router:b")).toBeLessThan(order.indexOf("app"))
    expect(schedule(tasks).map((t) => t.id)).toEqual(order)
  })

  it("schedule rejects cycles", () => {
    const cyclic: HarnessTask[] = [
      { id: "a", dependsOn: ["b"], scope: [], prompt: "" },
      { id: "b", dependsOn: ["a"], scope: [], prompt: "" },
    ]
    expect(() => schedule(cyclic)).toThrow(/cycle/)
  })

  it("executes tasks in dependency order and attributes produced files", async () => {
    const order: string[] = []
    const runner = fakeRunner({
      models: (cwd) => fs.writeFileSync(path.join(cwd, "app/models.py"), "models\n"),
      "router:a": (cwd) => fs.writeFileSync(path.join(cwd, "app/routers/a.py"), "a\n"),
      "router:b": (cwd) => fs.writeFileSync(path.join(cwd, "app/routers/b.py"), "b\n"),
      app: (cwd) => {
        order.push("app-after-routers")
        fs.writeFileSync(path.join(cwd, "app/main.py"), "main\n")
      },
    })
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "spec-harness-"))
    fs.mkdirSync(path.join(ws, "app", "routers"), { recursive: true })
    const report = await new AgentHarness({ runner }).execute(ws, tasks)

    expect(report.ok).toBe(true)
    expect(report.results.map((r) => r.id)).toEqual(["models", "router:a", "router:b", "app"])
    // the app task really ran after both routers wrote their files
    expect(order).toEqual(["app-after-routers"])
    const app = report.results.find((r) => r.id === "app")!
    expect(app.produced.map((p) => p.path)).toEqual(["app/main.py"])
    expect(app.scopeViolations).toEqual([])
    expect(fs.readFileSync(path.join(ws, "app/main.py"), "utf8")).toBe("main\n")
  })

  it("detects scope violations and stops on failed tasks", async () => {
    const runner = fakeRunner({
      models: (cwd) => fs.writeFileSync(path.join(cwd, "app/models.py"), "models\n"),
      "router:a": (cwd) => {
        fs.writeFileSync(path.join(cwd, "app/routers/a.py"), "a\n")
        fs.writeFileSync(path.join(cwd, "app/rogue.py"), "rogue\n") // out of scope
      },
      "router:b": () => {
        throw new Error("router:b must not run — the chain is broken")
      },
      app: () => {
        throw new Error("app must not run")
      },
    })
    // make router:b fail: replace its handler effect by returning ok:false
    const failing = {
      run: async (prompt: string, cwd: string): Promise<AgentRunResult> => {
        if (prompt.includes("# Task: models")) {
          fs.writeFileSync(path.join(cwd, "app/models.py"), "models\n")
          return { ok: true }
        }
        if (prompt.includes("# Task: router:a")) {
          fs.writeFileSync(path.join(cwd, "app/routers/a.py"), "a\n")
          fs.writeFileSync(path.join(cwd, "app/rogue.py"), "rogue\n")
          return { ok: true }
        }
        if (prompt.includes("# Task: router:b")) return { ok: false, error: "boom" }
        throw new Error("app must not run after a failure")
      },
    }
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "spec-harness-"))
    fs.mkdirSync(path.join(ws, "app", "routers"), { recursive: true })
    const report = await new AgentHarness({
      runner: failing as unknown as ClaudeCodeAgentRunner,
    }).execute(ws, tasks)

    expect(report.ok).toBe(false)
    expect(report.results.map((r) => r.id)).toEqual(["models", "router:a", "router:b"])
    const rogue = report.results.find((r) => r.id === "router:a")!
    expect(rogue.scopeViolations).toEqual(["app/rogue.py"])
    void runner
  })
})

describe("GitHub generator DAG execution", () => {
  it("preserves generator edges while assigning every node a branchable task", () => {
    const hash = "b".repeat(64)
    const plan = createGitHubGenerationPlan({
      shot: {
        tasks: [
          { id: "project", label: "project", dependsOn: [], scope: ["pyproject.toml"], prompt: "project" },
          { id: "router:posts", label: "router", dependsOn: ["project"], scope: ["app/router.py"], prompt: "router" },
          { id: "app", label: "app", dependsOn: ["router:posts"], scope: ["app/main.py"], prompt: "app" },
        ],
        conformanceFiles: { "conformance/test_app.py": "def test_app(): pass\n" },
        verification: { setup: [], check: [{ name: "pytest", command: "pytest -q", timeoutMs: 1000 }] },
      },
      runId: "media-v1",
      repository: "owner/repo",
      rootBaseSha: "a".repeat(40),
      targetDirectory: "products/media/backend",
      environment: {
        image: `ghcr.io/owner/dev@sha256:${"c".repeat(64)}`,
        devcontainerHash: hash,
        toolchainLockHash: hash,
      },
      requiredChecks: ["spec-generation"],
    })
    expect(plan.branchPrefix).toBe("spec/generate")
    expect(plan.tasks.map((task) => task.id)).toEqual(["app", "conformance", "project", "router-posts"])
    expect(plan.tasks.find((task) => task.id === "router-posts")?.dependsOn).toEqual(["project"])
    expect(plan.tasks.find((task) => task.id === "app")?.dependsOn).toEqual(["router-posts"])
    expect(plan.tasks.find((task) => task.id === "conformance")?.dependsOn).toEqual(["app"])
    expect(plan.tasks.find((task) => task.id === "project")?.scope).toEqual(["products/media/backend/pyproject.toml"])
  })
})
