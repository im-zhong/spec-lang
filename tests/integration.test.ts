import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

const projectRoot = path.resolve(__dirname, "..")
const cliDist = path.join(projectRoot, "packages", "cli", "dist", "index.js")
const exampleDir = path.join(projectRoot, "examples", "basic-web-app")

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

describe("CLI integration (spec §59/§60 acceptance)", () => {
  it("spec check succeeds on the example app (exit 0)", () => {
    const result = runCli(["check", "app.spec.ts"], exampleDir)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("✓ Specification valid")
  })

  it("spec build writes deterministic artifacts (exit 0)", () => {
    const result = runCli(["build", "app.spec.ts"], exampleDir)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("✓ Specification compiled")
    expect(result.stdout).toContain(".spec/spec.ir.json")

    const outDir = path.join(exampleDir, ".spec")
    expect(fs.existsSync(path.join(outDir, "spec.ir.json"))).toBe(true)
    expect(fs.existsSync(path.join(outDir, "manifest.json"))).toBe(true)
    expect(fs.existsSync(path.join(outDir, "diagnostics.json"))).toBe(true)

    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"))
    expect(manifest).toEqual({
      specVersion: "0.1",
      compilerVersion: "0.1.0",
      entry: "app.spec.ts",
      packages: {
        "@spec/auth": "0.1.0",
        "@spec/core": "0.1.0",
        "@spec/postgres": "0.1.0",
        "@spec/web": "0.1.0",
      },
    })

    // deterministic: rebuilding produces byte-identical artifacts
    const first = fs.readFileSync(path.join(outDir, "spec.ir.json"), "utf8")
    runCli(["build", "app.spec.ts"], exampleDir)
    const second = fs.readFileSync(path.join(outDir, "spec.ir.json"), "utf8")
    expect(second).toBe(first)
  })

  it("spec inspect prints the specification tree (exit 0)", () => {
    const result = runCli(["inspect", "app.spec.ts"], exampleDir)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Application ExampleApp")
    expect(result.stdout).toContain("User")
    expect(result.stdout).toContain("email: email [unique]")
    expect(result.stdout).toContain("principal: User")
    expect(result.stdout).toContain("identity: User.email")
    expect(result.stdout).toContain("PostgreSQL")
  })

  it("spec check fails on the invalid auth identity fixture (exit 1)", () => {
    const result = runCli(
      ["check", "tests/fixtures/invalid-auth-identity/app.spec.ts"],
      projectRoot,
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("AUTH_IDENTITY_NOT_IN_PRINCIPAL")
    expect(result.stderr).toContain("app.spec.ts:")
  })

  it("spec check exits 2 for unknown commands", () => {
    const result = runCli(["frobnicate", "app.spec.ts"], exampleDir)
    expect(result.status).toBe(2)
  })
})
