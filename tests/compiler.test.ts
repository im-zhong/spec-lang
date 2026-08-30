import { describe, expect, it } from "vitest"
import { compile } from "@spec/compiler"
import * as path from "node:path"

const projectRoot = path.resolve(__dirname, "..")

function fixture(name: string) {
  return compile(path.join("tests", "fixtures", name, "app.spec.ts"), { projectRoot })
}

function codes(diagnostics: { code: string; level: string }[]) {
  return diagnostics.map((d) => d.code)
}

describe("compiler pipeline", () => {
  it("compiles the valid basic app with no errors", async () => {
    const result = await fixture("valid-basic-app")
    expect(result.ok).toBe(true)
    expect(result.diagnostics.filter((d) => d.level === "error")).toEqual([])
  })

  it("IR expresses the full acceptance surface (spec §59)", async () => {
    const result = await fixture("valid-basic-app")
    const ir = result.ir
    expect(ir.version).toBe("spec-ir/0.1")
    expect(ir.app.name).toBe("ExampleApp")
    expect(ir.metadata.compilerVersion).toBe("0.1.0")

    const ids = ir.nodes.map((n) => n.id)
    expect(ids).toContain("app:ExampleApp")
    expect(ids).toContain("entity:User")

    const user = ir.nodes.find((n) => n.id === "entity:User")
    expect(user?.package).toBe("@spec/web")
    expect(user?.attributes.fields).toEqual({
      id: { type: "uuid" },
      email: { type: "email", unique: true },
      name: { type: "string" },
    })
    expect(user?.source).toMatchObject({ file: expect.stringContaining("app.spec.ts") })

    const authNode = ir.nodes.find((n) => n.kind === "auth")
    expect(authNode?.attributes.principal).toEqual({ nodeId: "entity:User" })
    const strategy = authNode?.children?.find((c) => c.kind === "passwordStrategy")
    expect(strategy?.attributes.identity).toMatchObject({ entity: "User", field: "email" })

    const db = ir.nodes.find((n) => n.kind === "postgres")
    expect(db?.attributes.entities).toEqual([{ nodeId: "entity:User" }])

    expect(ir.packages.map((p) => p.name)).toEqual([
      "@spec/auth",
      "@spec/core",
      "@spec/postgres",
      "@spec/web",
    ])
    expect(ir.capabilities.provided).toEqual([
      { capability: "RelationalStore", provider: "postgres:MainDB" },
    ])
    expect(ir.capabilities.required).toEqual([
      { capability: "RelationalStore", requester: "auth:MainAuth" },
    ])
  })

  it("rejects an auth identity that is not in the principal (spec §60)", async () => {
    const result = await fixture("invalid-auth-identity")
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toContain("AUTH_IDENTITY_NOT_IN_PRINCIPAL")
    const diag = result.diagnostics.find((d) => d.code === "AUTH_IDENTITY_NOT_IN_PRINCIPAL")
    expect(diag?.level).toBe("error")
    expect(diag?.source?.file).toContain("app.spec.ts")
    expect(diag?.source?.line).toBeGreaterThan(0)
  })

  it("reports a missing capability provider when no database resource exists", async () => {
    const result = await fixture("missing-database")
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("MISSING_CAPABILITY_PROVIDER")
  })

  it("reports duplicate entity names", async () => {
    const result = await fixture("duplicate-entity")
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("DUPLICATE_ENTITY_NAME")
    expect(codes(result.diagnostics)).toContain("NODE_ID_COLLISION")
  })

  it("rejects unsupported TypeScript syntax", async () => {
    const result = await fixture("unsupported-syntax")
    expect(result.ok).toBe(false)
    const unsupported = result.diagnostics.filter((d) => d.code === "SPEC_UNSUPPORTED_SYNTAX")
    expect(unsupported.length).toBeGreaterThan(0)
    expect(unsupported.every((d) => d.source !== undefined)).toBe(true)
  })

  it("warns (but succeeds) on a non-unique auth identity", async () => {
    const result = await fixture("identity-not-unique")
    expect(result.ok).toBe(true)
    const warning = result.diagnostics.find((d) => d.code === "AUTH_IDENTITY_NOT_UNIQUE")
    expect(warning?.level).toBe("warning")
  })

  it("reports a missing entry file as a structured diagnostic", async () => {
    const result = await compile("tests/fixtures/does-not-exist/app.spec.ts", { projectRoot })
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toContain("SPEC_ENTRY_NOT_FOUND")
  })
})
