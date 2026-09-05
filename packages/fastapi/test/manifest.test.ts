import { describe, expect, it } from "vitest"
import * as path from "node:path"
import { compile } from "@spec/compiler"
import { clausesByTask, planGeneration } from "../src"
import { coverageDiagnostics, deriveTestManifest } from "../src/manifest"

const ROOT = path.resolve(__dirname, "../../../")

async function planFor(name: string) {
  const result = await compile(`examples/${name}/app.spec.ts`, { projectRoot: ROOT })
  expect(result.ok).toBe(true)
  return planGeneration(result.ir)
}

describe("test manifest (coverage as a compile fact)", () => {
  it("maps every oracle clause of the smoke spec to in-loop coverage", async () => {
    const plan = await planFor("smoke")
    const gate = coverageDiagnostics(
      plan.coverage,
      plan.dag.tasks.flatMap((task) => task.clauses),
    )
    expect(gate.filter((d) => d.level === "error")).toEqual([])
    // Group 1 closed the historical gaps: infra adapters and invariants now
    // have in-loop probes, not just terminal judgment.
    expect(gate.filter((d) => d.code === "TEST_COVERAGE_TERMINAL_ONLY")).toEqual([])
    const coverage = plan.coverage.coverage
    expect(coverage["adapter:app:blob:s3"].inLoop).toContain("node-behavior:blob")
    expect(coverage["adapter:app:cache:redis"].inLoop).toContain("node-behavior:cache")
    expect(coverage["adapter:app:messaging:rabbitmq"].inLoop).toContain("node-behavior:messaging")
    expect(coverage["invariant:no-overbooking"].inLoop).toContain("triple invariant:no-overbooking")
    expect(coverage["invariant:venue-name-allowed"].inLoop).toContain("triple invariant:venue-name-allowed")
    expect(coverage["route:POST /auth/login"].inLoop).toContain("triple login:POST /auth/login")
    expect(coverage["route:POST /bookings/{id}/confirm:transition"].inLoop).toContain("triple transition:POST /bookings/{id}/confirm")
    expect(coverage["route:POST /bookings"].inLoop).toContain("triple create:POST /bookings")
    expect(coverage["example:venue-create-exact"].inLoop).toContain("triple example:venue-create-exact")
    expect(coverage["route:POST /venues"].terminal).toContain("conformance test_contract.py")
  })

  it("derives deterministically", async () => {
    const first = await planFor("smoke")
    const second = await planFor("smoke")
    expect(JSON.stringify(second.coverage)).toBe(JSON.stringify(first.coverage))
  })

  it("fails loud: uncovered oracle clauses are compile errors, terminal-only is info", () => {
    const manifest = deriveTestManifest(
      {
        routes: [],
        entities: [],
        lifecycles: [],
        invariants: [],
        examples: [],
      } as never,
      [],
    )
    const gate = coverageDiagnostics(manifest, [
      { id: "route:GET /ghosts", verification: "oracle" },
      { id: "review:app:cache:no-extra-apis", verification: "review" },
    ])
    const missing = gate.find((d) => d.code === "TEST_COVERAGE_MISSING")
    expect(missing?.level).toBe("error")
    expect(missing?.message).toContain("route:GET /ghosts")
    // Review clauses are covered by the reviewer by design — never gated.
    expect(gate.filter((d) => d.message.includes("no-extra-apis"))).toEqual([])

    const terminalOnly = coverageDiagnostics(
      { coverage: { "route:GET /only-terminal": { inLoop: [], terminal: ["conformance"] } } },
      [{ id: "route:GET /only-terminal", verification: "oracle" }],
    )
    expect(terminalOnly[0].code).toBe("TEST_COVERAGE_TERMINAL_ONLY")
    expect(terminalOnly[0].level).toBe("info")
  })

  it("clause tables and the manifest agree on clause ids", async () => {
    const plan = await planFor("booking")
    const grouped = clausesByTask(plan.blueprint)
    for (const [node, clauses] of grouped) {
      for (const clause of clauses) {
        const entry = plan.coverage.coverage[clause.id]
        if (clause.verification === "oracle") {
          expect(entry, `${node}/${clause.id}`).toBeDefined()
        }
      }
    }
  })
})
