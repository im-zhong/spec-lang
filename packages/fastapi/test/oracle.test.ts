import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { compile } from "@spec/compiler"
import { buildNodeOracles, oracleFileFor, planGeneration, testCommandFor } from "../src"

const ROOT = path.resolve(__dirname, "../../../")

async function planFor(name: string) {
  const result = await compile(`examples/${name}/app.spec.ts`, { projectRoot: ROOT })
  expect(result.ok).toBe(true)
  return planGeneration(result.ir)
}

function pythonAvailable(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const hasPython = pythonAvailable()

function pyCompile(files: Record<string, string>): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-oracle-pycompile-"))
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
      execFileSync("python3", ["-m", "py_compile", target], { stdio: "pipe" })
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("compiler-generated node oracles", () => {
  it("seeds one oracle test per task plus a shared runner, byte-deterministically", async () => {
    const first = await planFor("booking")
    const second = await planFor("booking")
    expect(first.seedFiles).toEqual(second.seedFiles)

    const oracleFiles = Object.keys(first.seedFiles).filter((file) => file.startsWith("tests/spec_oracle/"))
    expect(oracleFiles).toHaveLength(first.dag.tasks.length + 1)
    expect(oracleFiles).toContain("tests/spec_oracle/runner.py")
    for (const task of first.dag.tasks) {
      expect(oracleFiles).toContain(oracleFileFor(task.id))
    }
    const project = first.seedFiles[oracleFileFor("project")]!
    expect(project).toContain("Compiler-owned node oracle")
    expect(project).toContain('\\"kind\\": \\"project\\"')
    const router = first.seedFiles[oracleFileFor("router:Booking")]!
    expect(router).toContain('\\"kind\\": \\"router\\"')
    expect(router).toContain("POST /bookings")
  })

  it("builds the pinned uv command through one author", async () => {
    const plan = await planFor("booking")
    const command = testCommandFor(plan.blueprint, oracleFileFor("router:Booking"))
    expect(command).toBe(plan.dag.tasks.find((task) => task.id === "router:Booking")!.loop!.reviewer.commands[0])
    expect(command.startsWith("uv run --no-project --python '3.13'")).toBe(true)
    expect(command).toContain("'fastapi==")
    expect(command.endsWith(`pytest -p no:cacheprovider -q ${oracleFileFor("router:Booking")}`)).toBe(true)
  })

  it("leaves review-kind clauses out of the CONTRACT probes but listed for the reviewer", async () => {
    const plan = await planFor("media-platform")
    const blob = plan.seedFiles[oracleFileFor("blob")]!
    expect(blob).toContain('\\"kind\\": \\"blob\\"')
    expect(blob).toContain("review:app:blob:no-extra-apis")
    // The per-node CONTRACT embeds the clause manifest, not statements.
    expect(blob).not.toContain('"statement"')
  })

  it("generates py_compile-clean oracle files for every example", async () => {
    if (!hasPython) return
    for (const name of ["cblog", "inventory", "booking", "media-platform", "store-platform"]) {
      const plan = await planFor(name)
      const files = buildNodeOracles(plan.blueprint, plan.dag.tasks).files
      expect(Object.keys(files)).toEqual(Object.keys(plan.seedFiles).filter((file) => file.startsWith("tests/spec_oracle/")))
      pyCompile(files)
    }
  })

  it("runs the booking oracle command form for every task", async () => {
    const plan = await planFor("booking")
    for (const task of plan.dag.tasks) {
      expect(task.acceptanceCommands).toEqual([testCommandFor(plan.blueprint, oracleFileFor(task.id))])
      expect(task.loop?.reviewer.commands).toEqual(task.acceptanceCommands)
      expect(task.loop?.reviewer.oracleFiles).toEqual(["tests/spec_oracle/runner.py", oracleFileFor(task.id)].sort())
    }
  })
})
