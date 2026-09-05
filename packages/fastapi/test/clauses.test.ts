import { describe, expect, it } from "vitest"
import * as path from "node:path"
import { compile } from "@spec/compiler"
import { buildBlueprint, clausesByTask, deriveClauses, planGeneration } from "../src"
import type { ContractClause, SpecIR } from "@spec/core"

const ROOT = path.resolve(__dirname, "../../../")

async function irFor(name: string): Promise<SpecIR> {
  const result = await compile(`examples/${name}/app.spec.ts`, { projectRoot: ROOT })
  expect(result.ok).toBe(true)
  return result.ir
}

const VERIFICATIONS = new Set(["oracle", "lint", "review"])
const LEVELS = new Set(["api", "function"])

function assertWellFormed(clauses: ContractClause[]): void {
  const perNode = new Map<string, Set<string>>()
  for (const clause of clauses) {
    expect(clause.statement.trim().length, `statement of ${clause.id}`).toBeGreaterThan(0)
    expect(VERIFICATIONS).toContain(clause.verification)
    expect(LEVELS).toContain(clause.level)
    expect(clause.node.trim().length).toBeGreaterThan(0)
    const seen = perNode.get(clause.node) ?? new Set<string>()
    expect(seen.has(clause.id), `duplicate clause id ${clause.id} on ${clause.node}`).toBe(false)
    seen.add(clause.id)
    perNode.set(clause.node, seen)
  }
}

describe("clause derivation", () => {
  it("is byte-deterministic across plans and covers exactly the DAG task set", async () => {
    const ir = await irFor("booking")
    const first = planGeneration(ir)
    const second = planGeneration(ir)
    expect(JSON.stringify(clausesByTask(first.blueprint))).toBe(JSON.stringify(clausesByTask(second.blueprint)))
    const grouped = clausesByTask(first.blueprint)
    for (const task of first.dag.tasks) {
      expect(grouped.get(task.id), `clauses for ${task.id}`).toBeDefined()
      expect(task.clauses.map((c) => c.id)).toEqual((grouped.get(task.id) ?? []).map((c) => c.id))
    }
    const taskIds = new Set(first.dag.tasks.map((t) => t.id))
    for (const node of grouped.keys()) {
      expect(taskIds.has(node), `clause node ${node} has no task`).toBe(true)
    }
  })

  it("emits no lint clauses and only well-formed review clauses", async () => {
    for (const name of ["cblog", "inventory", "booking", "media-platform", "store-platform"]) {
      const ir = await irFor(name)
      const clauses = deriveClauses(buildBlueprint(ir))
      assertWellFormed(clauses)
      expect(clauses.filter((c) => c.verification === "lint"), `${name} lint clauses`).toHaveLength(0)
    }
  })

  it("derives booking's transition and invariant clauses on the preserving routers", async () => {
    const ir = await irFor("booking")
    const grouped = clausesByTask(buildBlueprint(ir))
    const booking = grouped.get("router:Booking")!
    const confirm = booking.find((c) => c.id === "route:POST /bookings/{id}/confirm:transition")
    expect(confirm?.statement).toContain('to "confirmed"')
    expect(confirm?.statement).toContain("guard")
    expect(booking.find((c) => c.id === "invariant:no-overbooking")).toBeDefined()
    expect(grouped.get("router:Venue")!.find((c) => c.id === "invariant:no-overbooking")).toBeDefined()
    const venue = grouped.get("router:Venue")!
    expect(venue.find((c) => c.id === "route:PATCH /venues/{id}")).toBeDefined()
  })

  it("derives cblog's rowCheck invariant and pins the project clause set", async () => {
    const ir = await irFor("cblog")
    const grouped = clausesByTask(buildBlueprint(ir))
    expect(grouped.get("router:Post")!.find((c) => c.id === "invariant:no-empty-title")).toBeDefined()
    const project = grouped.get("project")!
    expect(project.find((c) => c.id === "pin:pyproject:name")?.statement).toContain('"contentapi"')
    expect(project.find((c) => c.id === "pin:pyproject:dependencies")?.statement).toContain("fastapi==")
    expect(project.find((c) => c.id === "pin:pyproject:no-passlib")).toBeDefined()
  })

  it("derives media-platform's selector and adapter-call clauses", async () => {
    const ir = await irFor("media-platform")
    const grouped = clausesByTask(buildBlueprint(ir))
    const blob = grouped.get("blob")!
    expect(blob.find((c) => c.id === "selector:app:blob:policy_name")).toBeDefined()
    const messaging = grouped.get("messaging")!
    for (const provider of ["kafka", "sqs"]) {
      expect(messaging.find((c) => c.id === `adapter:app:messaging:${provider}`)).toBeDefined()
    }
    const cache = grouped.get("cache")!
    expect(cache.find((c) => c.id === "adapter:app:cache:redis")).toBeDefined()
    expect(cache.find((c) => c.id === "review:app:cache:no-extra-apis")?.verification).toBe("review")
  })

  it("compiles the import slice into the kernel and pins the reading discipline", async () => {
    const ir = await irFor("booking")
    const plan = planGeneration(ir)
    for (const task of plan.dag.tasks) {
      expect(task.prompt, task.id).not.toContain("READ them for context")
      expect(task.prompt, task.id).toContain("## Reading discipline")
      expect(task.prompt, task.id).toContain("`conformance/`")
      expect(task.prompt, task.id).toContain("`tests/spec_oracle/`")
      expect(task.prompt, task.id).toContain("`.spec-input/`")
    }
    // The Booking router depends on models/schemas/database/security (auth):
    // its slice names every importable module and nothing else.
    const router = plan.dag.tasks.find((t) => t.id === "router:Booking")!
    expect(router.prompt).toContain("## Import surface")
    expect(router.prompt).toContain("`app.database`")
    expect(router.prompt).toContain("`app.models`")
    expect(router.prompt).toContain("`app.schemas`")
    expect(router.prompt).toContain("`app.security`")
    expect(router.prompt).not.toContain("`app.router_registry`")
    // The app task consumes the compiler-owned registry instead of siblings.
    const app = plan.dag.tasks.find((t) => t.id === "app")!
    expect(app.prompt).toContain("`app.router_registry`")
    // A dependency-free task says so instead of rendering an empty slice.
    const project = plan.dag.tasks.find((t) => t.id === "project")!
    expect(project.prompt).toContain("this task stands alone")
  })

  it("renders every clause verbatim inside the task prompt kernel", async () => {
    const ir = await irFor("booking")
    const plan = planGeneration(ir)
    for (const task of plan.dag.tasks) {
      for (const clause of task.clauses) {
        expect(task.prompt).toContain(`[${clause.id}]`)
      }
      expect(task.prompt).toContain("## Contract challenge protocol")
      expect(task.prompt).toContain('"challenge"')
    }
  })
})
