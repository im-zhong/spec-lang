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

  it("booking: lifecycle lowers to transition operations with pinned outcomes", async () => {
    const result = await compileExample("booking")
    const plan = planGeneration(result.ir)
    // the state machine itself (guards/effects asserted in the Phase-3 test)
    expect(plan.blueprint.lifecycles).toEqual([
      {
        entity: "Booking",
        field: "status",
        initial: "pending",
        transitions: [
          {
            event: "confirm",
            from: ["pending"],
            to: "confirmed",
            guard: {
              __expr: "cmp",
              op: "gt",
              left: { __expr: "field", name: "startsAt" },
              right: { __expr: "requestTime" },
            },
            effects: [{ __effect: "emit", event: "booking.confirmed", fields: ["id", "venue", "startsAt"] }],
          },
          {
            event: "cancel",
            from: ["pending", "confirmed"],
            to: "cancelled",
            effects: [{ __effect: "set", field: "cancelledAt", value: { __expr: "requestTime" } }],
          },
        ],
      },
    ])
    // one route per transition, mirroring the crud path
    const confirm = plan.blueprint.routes.find((r) => r.id === "POST /bookings/{id}/confirm")
    expect(confirm).toMatchObject({
      method: "POST",
      status: 200,
      auth: true,
      operation: "transition",
      entity: "Booking",
      response: { kind: "entity", entity: "Booking" },
      transition: { field: "status", event: "confirm", from: ["pending"], to: "confirmed" },
    })
    // the guard-failure body is part of the contract
    expect(plan.blueprint.contract.errors.guardFailed).toEqual({
      status: 409,
      body: { detail: "Invalid state" },
    })
    // the state field is server-controlled: excluded from create bodies
    const create = plan.blueprint.routes.find((r) => r.id === "POST /bookings")!
    expect(Object.keys(create.request!.shape)).not.toContain("status")
    // the conformance matrix asserts legal/illegal/unknown-id outcomes
    const testFile = plan.conformance.files["conformance/test_contract.py"]
    expect(testFile).toContain("def test_transition_confirm(client):")
    expect(testFile).toContain('assert r.json()["status"] == "confirmed"')
    expect(testFile).toContain('assert r.json() == {"detail": "Invalid state"}')
    expect(testFile).toContain("def test_transition_cancel(client):")
    // projects without lifecycles derive none
    const inventory = planGeneration((await compileExample("inventory")).ir)
    expect(inventory.blueprint.lifecycles).toEqual([])
  })

  it("booking: no-overbooking lowers and marks the preserving operations", async () => {
    const result = await compileExample("booking")
    const plan = planGeneration(result.ir)
    expect(plan.blueprint.invariants).toEqual([
      {
        id: "invariant:no-overbooking",
        name: "no-overbooking",
        entity: "Venue",
        shape: "crossRowCount",
        count: {
          entity: "Booking",
          refField: "venue",
          op: "lte",
          bound: { kind: "field", name: "capacity" },
        },
      },
    ])
    const marked = plan.blueprint.routes.filter((r) => r.invariantIds)
    expect(marked.map((r) => r.id).sort()).toEqual(["PATCH /venues/{id}", "POST /bookings"])
    expect(plan.blueprint.contract.errors.invariantViolated).toEqual({
      status: 409,
      body: { detail: "Invariant violated" },
    })
    // the minimally-violating-world test, from the same data
    const testFile = plan.conformance.files["conformance/test_contract.py"]
    expect(testFile).toContain("def test_invariant_no_overbooking(client):")
    expect(testFile).toContain('overrides={"capacity": 0}')
    expect(testFile).toContain('assert r.json() == {"detail": "Invariant violated"}')
  })

  it("booking: Phase-3 guards and effects lower with pinned observables", async () => {
    const result = await compileExample("booking")
    const plan = planGeneration(result.ir)
    const confirm = plan.blueprint.routes.find((r) => r.id === "POST /bookings/{id}/confirm")!
    expect(confirm.transition!.guard).toEqual({
      __expr: "cmp",
      op: "gt",
      left: { __expr: "field", name: "startsAt" },
      right: { __expr: "requestTime" },
    })
    expect(confirm.transition!.effects).toEqual([
      { __effect: "emit", event: "booking.confirmed", fields: ["id", "venue", "startsAt"] },
    ])
    const cancel = plan.blueprint.routes.find((r) => r.id === "POST /bookings/{id}/cancel")!
    expect(cancel.transition!.effects).toEqual([
      { __effect: "set", field: "cancelledAt", value: { __expr: "requestTime" } },
    ])
    // the outbox table is declared iff some transition emits
    expect(plan.blueprint.effects).toEqual({
      eventsTable: "events",
      columns: { id: "uuid", event: "text", payload: "json", created_at: "datetime" },
    })
    const inventory = planGeneration((await compileExample("inventory")).ir)
    expect(inventory.blueprint.effects).toBeUndefined()
    // the suite tests the guard both ways and inspects the outbox
    const testFile = plan.conformance.files["conformance/test_contract.py"]
    expect(testFile).toContain('overrides={"startsAt": "2100-01-01T00:00:00"}')
    expect(testFile).toContain('overrides={"startsAt": "2000-01-01T00:00:00"}')
    expect(testFile).toContain("SELECT event, payload FROM events")
    expect(testFile).toContain('rw[0] == "booking.confirmed"')
    expect(testFile).toContain('assert payload["venue"] == row["venue"]')
    expect(testFile).toContain('assert r.json()["cancelledAt"] is not None')
  })

  it("cblog: the row-local invariant lowers and is asserted", async () => {
    const result = await compileExample("cblog")
    const plan = planGeneration(result.ir)
    expect(plan.blueprint.invariants).toEqual([
      {
        id: "invariant:no-empty-title",
        name: "no-empty-title",
        entity: "Post",
        shape: "rowCheck",
        check: {
          __expr: "cmp",
          op: "neq",
          left: { __expr: "field", name: "title" },
          right: { __expr: "const", value: "" },
        },
      },
    ])
    const marked = plan.blueprint.routes.filter((r) => r.invariantIds)
    expect(marked.map((r) => r.id).sort()).toEqual(["PATCH /posts/{id}", "POST /posts"])
    const testFile = plan.conformance.files["conformance/test_contract.py"]
    expect(testFile).toContain("def test_invariant_no_empty_title(client):")
    expect(testFile).toContain('"title": ""')
    expect(testFile).toContain('assert r.json() == {"detail": "Invariant violated"}')
    // inventory has no invariants
    const inventory = planGeneration((await compileExample("inventory")).ir)
    expect(inventory.blueprint.invariants).toEqual([])
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
  })

  it("derives a correct, deterministic generation DAG", async () => {
    const result = await compileExample("booking")
    const plan = planGeneration(result.ir)
    const ids = plan.dag.tasks.map((t) => t.id)
    expect(ids).toEqual([
      "project",
      "database",
      "models",
      "schemas",
      "security",
      "router:Booking",
      "router:User",
      "router:Venue",
      "router:auth",
      "app",
    ])
    // public router has no security dependency
    const venue = plan.dag.tasks.find((t) => t.id === "router:Venue")!
    expect(venue.dependsOn).not.toContain("security")
    const booking = plan.dag.tasks.find((t) => t.id === "router:Booking")!
    expect(booking.dependsOn).toContain("security")
    // topological correctness: every dependency appears before its dependents
    const seen = new Set<string>()
    for (const task of plan.dag.tasks) {
      for (const dep of task.dependsOn) expect(seen.has(dep)).toBe(true)
      seen.add(task.id)
    }
    // the no-auth project drops security and the auth router entirely
    const inventory = planGeneration((await compileExample("inventory")).ir)
    expect(inventory.dag.tasks.map((t) => t.id)).not.toContain("security")
    expect(inventory.dag.tasks.map((t) => t.id)).not.toContain("router:auth")
  })

  it("per-task prompts pin the contract and are deterministic", async () => {
    const result = await compileExample("cblog")
    const a = planGeneration(result.ir)
    const b = planGeneration(result.ir)
    const pa = a.dag.tasks.find((t) => t.id === "app")!.prompt
    const pb = b.dag.tasks.find((t) => t.id === "app")!.prompt
    expect(pa).toBe(pb)
    expect(pa).toContain("create_app(database_url")
    const models = a.dag.tasks.find((t) => t.id === "models")!.prompt
    expect(models).toContain("password_hash")
    const shared = a.dag.tasks.find((t) => t.id === "router:Post")!.prompt
    expect(shared).toContain('"detail": "Not authenticated"')
    expect(shared).toContain('"detail": "Already exists"')
    expect(shared).toContain("list returns EVERY row")
  })
})
