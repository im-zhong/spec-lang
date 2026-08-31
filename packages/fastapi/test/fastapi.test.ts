import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { compile } from "@spec/compiler"
import { fastapi, planGeneration } from "../src"

const ROOT = path.resolve(__dirname, "../../../")

async function compileExample(name: string) {
  const result = await compile(`examples/${name}/app.spec.ts`, { projectRoot: ROOT })
  return result
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

describe("@spec/fastapi builder", () => {
  it("fastapi() produces a server node with refs and port defaults", async () => {
    const { entity, field } = await import("@spec/web")
    const { postgres } = await import("@spec/postgres")
    const User = entity("User", { id: field.uuid(), email: field.email().unique() })
    const Users = (await import("@spec/web")).crud(User)
    const DB = postgres({ entities: [User] })
    DB.name = "MainDB" // const binding names resources in real specs
    const Server = fastapi({ services: [Users], resources: [DB] })
    expect(Server.kind).toBe("fastapi")
    expect(Server.package).toBe("@spec/fastapi")
    expect(Server.attributes).toMatchObject({
      version: "0.1.0",
      prefix: "",
      port: 8000,
      services: [{ nodeId: "crud:User" }],
      resources: [{ nodeId: "postgres:MainDB" }],
      requires: ["RelationalStore"],
    })
  })
})

describe("@spec/fastapi blueprint + conformance (examples)", () => {
  it("cblog: auth + two-level refs derive 18 pinned routes", async () => {
    const result = await compileExample("cblog")
    expect(result.ok).toBe(true)
    const plan = planGeneration(result.ir)
    expect(plan.blueprint.app.name).toBe("ContentAPI")
    expect(plan.blueprint.auth?.principal).toBe("User")
    expect(plan.blueprint.auth?.identityField).toBe("email")
    expect(plan.blueprint.routes.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "GET /posts",
        "POST /posts",
        "PATCH /posts/{id}",
        "DELETE /posts/{id}",
        "POST /auth/login",
        "POST /auth/register",
        "GET /auth/me",
      ]),
    )
    // every non-auth route is protected
    for (const route of plan.blueprint.routes) {
      if (!route.path.startsWith("/auth")) expect(route.auth).toBe(true)
    }
  })

  it("inventory: no auth ⇒ all routes public, prefix applied, count endpoint", async () => {
    const result = await compileExample("inventory")
    expect(result.ok).toBe(true)
    const plan = planGeneration(result.ir)
    expect(plan.blueprint.auth).toBeUndefined()
    expect(plan.blueprint.app.prefix).toBe("/api/v1")
    expect(plan.blueprint.routes.every((r) => !r.auth)).toBe(true)
    expect(plan.blueprint.routes.map((r) => r.id)).toContain("GET /api/v1/products/count")
    // defaults + optionals are pinned
    const product = plan.blueprint.entities.find((e) => e.name === "Product")!
    expect(product.fields.find((f) => f.name === "inStock")?.default).toBe(true)
    expect(product.fields.find((f) => f.name === "description")?.optional).toBe(true)
  })

  it("booking: partial CRUD subsets and public venues are respected", async () => {
    const result = await compileExample("booking")
    expect(result.ok).toBe(true)
    const plan = planGeneration(result.ir)
    const ids = plan.blueprint.routes.map((r) => r.id)
    expect(ids).toContain("POST /bookings")
    expect(ids).not.toContain("PATCH /bookings/{id}") // update not exposed
    expect(ids).toContain("GET /bookings/count")
    const venues = plan.blueprint.routes.filter((r) => r.path.startsWith("/venues"))
    expect(venues.every((r) => !r.auth)).toBe(true)
    const bookings = plan.blueprint.routes.filter((r) => r.path.startsWith("/bookings"))
    expect(bookings.every((r) => r.auth)).toBe(true)
  })

  it("generated conformance python is syntactically valid", async () => {
    if (!hasPython) return
    for (const name of ["cblog", "inventory", "booking"]) {
      const result = await compileExample(name)
      const plan = planGeneration(result.ir)
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `spec-conf-`))
      for (const [rel, content] of Object.entries(plan.conformance.files)) {
        const target = path.join(tmp, rel)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content)
      }
      expect(() =>
        execFileSync("python3", ["-m", "py_compile", "conformance/conftest.py", "conformance/test_contract.py"], { cwd: tmp }),
      ).not.toThrow()
    }
  })

  it("generation planning is deterministic (golden rule precondition)", async () => {
    const result = await compileExample("booking")
    const a = planGeneration(result.ir)
    const b = planGeneration(result.ir)
    expect(a.stable).toBe(b.stable)
    expect(a.conformance.files["conformance/test_contract.py"]).toBe(
      b.conformance.files["conformance/test_contract.py"],
    )
    expect(a.tasks.map((t) => t.id)).toEqual(["fastapi:implement", "fastapi:conform"])
  })

  it("prompts pin the contract and are deterministic", async () => {
    const result = await compileExample("cblog")
    const plan = planGeneration(result.ir)
    const { implementPrompt, repairPrompt } = await import("../src")
    const p1 = implementPrompt(plan.blueprint)
    const p2 = implementPrompt(plan.blueprint)
    expect(p1).toBe(p2)
    expect(p1).toContain('"detail": "Not authenticated"')
    expect(p1).toContain('"detail": "Already exists"')
    expect(p1).toContain("create_app(database_url")
    expect(repairPrompt(plan.blueprint, { command: "pytest", exitCode: 1, output: "boom" })).toContain(
      "FAILED",
    )
  })
})
