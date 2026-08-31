import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"

const projectRoot = path.resolve(__dirname, "..")
const cliDist = path.join(projectRoot, "packages", "cli", "dist", "index.js")

function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cliDist, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { status: 0, stdout, stderr: "" }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}

describe("spec generate (dry-run planning)", () => {
  it("plans the fastapi backend and writes deterministic planning artifacts", () => {
    const exampleDir = path.join(projectRoot, "examples", "booking")
    const first = runCli(["generate", "app.spec.ts", "--dry-run"], exampleDir)
    expect(first.status).toBe(0)
    expect(first.stdout).toContain("✓ Plan derived")

    const specDir = path.join(exampleDir, ".spec")
    const blueprintPath = path.join(specDir, "blueprint.json")
    const tasksPath = path.join(specDir, "agent.tasks.json")
    expect(fs.existsSync(blueprintPath)).toBe(true)
    expect(fs.existsSync(tasksPath)).toBe(true)

    const tasks = JSON.parse(fs.readFileSync(tasksPath, "utf8"))
    expect(tasks.tasks.map((t: { id: string }) => t.id)).toEqual([
      "fastapi:implement",
      "fastapi:conform",
    ])
    expect(tasks.conformanceFiles).toEqual([
      "conformance/conftest.py",
      "conformance/contract.json",
      "conformance/helpers.py",
      "conformance/test_contract.py",
    ])
    expect(tasks.verification.check.map((c: { name: string }) => c.name)).toEqual([
      "import",
      "conformance",
    ])

    const blueprint = JSON.parse(fs.readFileSync(blueprintPath, "utf8"))
    expect(blueprint.app.name).toBe("BookingAPI")
    expect(blueprint.contract.errors.alreadyExists).toEqual({
      status: 409,
      body: { detail: "Already exists" },
    })

    // deterministic: replanning produces byte-identical artifacts
    const hash = (p: string) =>
      createHash("sha256").update(fs.readFileSync(p)).digest("hex")
    const before = [hash(blueprintPath), hash(tasksPath)]
    runCli(["generate", "app.spec.ts", "--dry-run"], exampleDir)
    expect([hash(blueprintPath), hash(tasksPath)]).toEqual(before)
  })

  it("refuses to generate an invalid specification (exit 1)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gen-"))
    fs.writeFileSync(
      path.join(tmp, "app.spec.ts"),
      `import { defineApp } from "@spec/core"
import { entity, field, crud } from "@spec/web"

const Ghost = crud(entity("Ghost", { id: field.uuid() }))
void Ghost

export default defineApp({ name: "Broken", entities: [] })
`,
    )
    // module resolution needs the workspace packages reachable
    fs.symlinkSync(
      path.join(projectRoot, "examples", "booking", "node_modules"),
      path.join(tmp, "node_modules"),
    )
    const result = runCli(["generate", "app.spec.ts", "--dry-run"], tmp)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Specification invalid")
  })
})
