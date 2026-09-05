import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { compile } from "@spec/compiler"
import { planGeneration } from "../src"

const ROOT = path.resolve(__dirname, "../../../")

function pythonAvailable(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

async function smokeSeeds(): Promise<Record<string, string>> {
  const result = await compile("examples/smoke/app.spec.ts", { projectRoot: ROOT })
  expect(result.ok).toBe(true)
  return planGeneration(result.ir).seedFiles
}

describe("detection registry survives the skeleton state (defect #34)", () => {
  it("imports cleanly with ZERO routers present and discovers them as they land", async () => {
    if (!pythonAvailable()) return
    const seeds = await smokeSeeds()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spec-reg-"))
    fs.mkdirSync(path.join(tmp, "app"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "app", "__init__.py"), "")
    fs.writeFileSync(path.join(tmp, "app", "router_registry.py"), seeds["app/router_registry.py"])

    // The exact skeleton state that killed v6: app/ exists, app/routers/ does not.
    const skeleton = execFileSync(
      "python3",
      ["-c", "import app.router_registry as r; assert list(r.ROUTERS) == [], r.ROUTERS; print('skeleton-ok')"],
      { cwd: tmp, encoding: "utf8" },
    )
    expect(skeleton.trim()).toBe("skeleton-ok")

    // A router lands → it is discovered (namespace package, no __init__.py needed).
    fs.mkdirSync(path.join(tmp, "app", "routers"), { recursive: true })
    // A plain object stands in for the router: the registry only touches .router
    fs.writeFileSync(
      path.join(tmp, "app", "routers", "venue.py"),
      "class _R:\n    prefix = '/venues'\nrouter = _R()\n",
    )
    const grown = execFileSync(
      "python3",
      ["-c", "import app.router_registry as r; assert [rt.prefix for rt in r.ROUTERS] == ['/venues']; print('grown-ok')"],
      { cwd: tmp, encoding: "utf8" },
    )
    expect(grown.trim()).toBe("grown-ok")
  })

  it("the app oracle runner guards the same parent-import", async () => {
    const seeds = await smokeSeeds()
    const runner = seeds["tests/spec_oracle/runner.py"]
    // The oracle probes candidates with find_spec; the parent may be absent.
    expect(runner).toContain("except ModuleNotFoundError")
  })
})
