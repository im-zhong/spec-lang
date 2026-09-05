import { describe, expect, it } from "vitest"
import * as path from "node:path"
import { compile } from "@spec/compiler"
import { clausesByTask, planGeneration } from "../src"

const ROOT = path.resolve(__dirname, "../../../")

async function planFor() {
  const result = await compile("examples/bounds/app.spec.ts", { projectRoot: ROOT })
  expect(result.ok).toBe(true)
  return planGeneration(result.ir)
}

describe("declared field bounds (validation → 422, never the invariant 409)", () => {
  it("flow into blueprint fields", async () => {
    const plan = await planFor()
    const venue = plan.blueprint.entities.find((e) => e.name === "Venue")!
    expect(venue.fields.find((f) => f.name === "capacity")).toMatchObject({ min: 1, max: 10 })
    expect(venue.fields.find((f) => f.name === "name")).toMatchObject({ maxLength: 8 })
    const room = plan.blueprint.entities.find((e) => e.name === "Room")!
    expect(room.fields.find((f) => f.name === "seats")).toMatchObject({ min: 0, max: 2 })
  })

  it("pin pydantic constraint clauses on the schemas node", async () => {
    const plan = await planFor()
    const clauses = clausesByTask(plan.blueprint).get("schemas")!
    const capacity = clauses.find((c) => c.id === "schemas:Venue:bound:capacity")!
    expect(capacity.statement).toContain(">= 1")
    expect(capacity.statement).toContain("<= 10")
    expect(capacity.statement).toContain("422")
    expect(clauses.find((c) => c.id === "schemas:Venue:bound:name")!.statement).toContain("length <= 8")
    expect(clauses.find((c) => c.id === "schemas:Room:bound:seats")).toBeDefined()
    expect(clauses.find((c) => c.id === "schemas:Room:bound:label")).toBeDefined()
  })

  it("clamp conformance samples to the inclusive edge and probe both sides of each boundary", async () => {
    const plan = await planFor()
    const contract = plan.conformance.files["conformance/test_contract.py"]
    const helpers = plan.conformance.files["conformance/helpers.py"]
    // 42 clamps to the inclusive max edge; update uses a distinct in-bounds value.
    expect(helpers).toContain('"capacity": 10')
    expect(contract).toContain('"capacity": 7}')
    // Out-of-range probes answer the default 422: min-1, max+1, maxLength+1.
    expect(contract).toContain('"capacity": 0}')
    expect(contract).toContain('"capacity": 11}')
    expect(contract).toContain('"seats": -1}')
    expect(contract).toContain('"seats": 3}')
    expect(contract).toContain('"name": "x" * 9}')
    expect(contract).toContain('"label": "x" * 11}')
    // Declared maxLength caps every emitted sample (uuid hex slice for unique).
    expect(helpers).toContain('f"{uuid.uuid4().hex[:8]}"')
    expect(helpers).toContain('"label": "sample-lab"')
  })

  it("carry bounds into the schemas node oracle contract and stay deterministic", async () => {
    const first = await planFor()
    const oracleFile = first.seedFiles["tests/spec_oracle/test_schemas.py"]!
    const embedded = oracleFile.match(/CONTRACT = json\.loads\((.*)\)/)![1]
    const contract = JSON.parse(JSON.parse(embedded)) as {
      entities: Array<{ name: string; bounds: Array<Record<string, unknown>> }>
    }
    const venue = contract.entities.find((e) => e.name === "Venue")!
    expect(venue.bounds).toEqual([
      { field: "capacity", ge: 1, le: 10 },
      { field: "name", maxLength: 8 },
    ])
    const room = contract.entities.find((e) => e.name === "Room")!
    expect(room.bounds).toEqual([
      { field: "label", maxLength: 10 },
      { field: "seats", ge: 0, le: 2 },
    ])
    const second = await planFor()
    expect(second.stable).toBe(first.stable)
  })

  it("resolve author examples onto their routes, clauses, and literal tests", async () => {
    const plan = await planFor()
    expect(plan.blueprint.examples.map((e) => e.name)).toEqual([
      "venue-create",
      "venue-create-exact",
      "venue-delete",
      "venue-open",
      "venue-open-small-capacity-rejected",
    ])
    expect(plan.blueprint.examples.find((e) => e.name === "venue-open")!.routeId).toBe("POST /venues/{id}/open")

    // The example clause lands on the owning router node with its values.
    const routerClauses = clausesByTask(plan.blueprint).get("router:Venue")!
    const createClause = routerClauses.find((c) => c.id === "example:venue-create")!
    expect(createClause.statement).toContain('"capacity":7')
    expect(createClause.statement).toContain("answers exactly 201")
    const rejectClause = routerClauses.find((c) => c.id === "example:venue-open-small-capacity-rejected")!
    expect(rejectClause.statement).toContain("answers exactly 409")
    // v2: predicates and state render into the clause prose.
    const exactClause = routerClauses.find((c) => c.id === "example:venue-create-exact")!
    expect(exactClause.statement).toContain("<not-null>")
    expect(exactClause.statement).toContain("Venue rows +1")
    const openClause = routerClauses.find((c) => c.id === "example:venue-open")!
    expect(openClause.statement).toContain('"venue.opened" row with payload fields {id, name} from $v')

    // The conformance bytes are the author's literals, verbatim.
    const examples = plan.conformance.files["conformance/test_examples.py"]
    expect(examples).toContain('json={"capacity": 7, "name": "hall"}')
    expect(examples).toContain('assert r.json()["capacity"] == 7')
    expect(examples).toContain('assert r.json()["state"] == "draft"')
    expect(examples).toContain('_tight = create_row(client, "Venue", overrides={"capacity": 1})')
    expect(examples).toContain('assert r.json()["detail"] == "Invalid state"')
  })

  it("lower v2 expectations: exact key set, predicates, bindings, outbox, count deltas", async () => {
    const plan = await planFor()
    const examples = plan.conformance.files["conformance/test_examples.py"]
    // exact mode pins the full response key set; NOT_NULL covers the id.
    expect(examples).toContain('assert set(r.json().keys()) == {"capacity", "id", "name", "state"}')
    expect(examples).toContain('assert r.json()["id"] is not None')
    // ANY asserts presence only.
    expect(examples).toContain('assert "id" in r.json()')
    // count deltas snapshot before the request and assert the world effect.
    expect(examples).toContain('def _table_count(client, table):')
    expect(examples).toContain('_before_venues = _table_count(client, "venues")')
    expect(examples).toContain("assert _table_count(client, \"venues\") == _before_venues + 1")
    expect(examples).toContain("assert _table_count(client, \"venues\") == _before_venues - 1")
    expect(examples).toContain("assert _table_count(client, \"venues\") == _before_venues")
    // outbox assertion reads the events table and matches the fixture row.
    expect(examples).toContain('matching = [rw for rw in rows if rw[0] == "venue.opened"]')
    expect(examples).toContain('assert set(payload.keys()) == {"id", "name"}')
    expect(examples).toContain('assert payload["name"] == _v["name"]')
  })

  it("compile router behavior triples into the node oracle contract (oracle v2)", async () => {
    const plan = await planFor()
    const oracleFile = plan.seedFiles["tests/spec_oracle/test_router_venue.py"]!
    const embedded = oracleFile.match(/CONTRACT = json\.loads\((.*)\)/)![1]
    const contract = JSON.parse(JSON.parse(embedded)) as {
      behavior: { triples: Array<{ label?: string; request: { method: string; path: string }; expect: { status: number } }> }
    }
    const labels = contract.behavior.triples.map((t) => t.label ?? "")
    // rule-derived probes: happy echo, conflict, validation, bounds,
    // read/update/delete, and every transition direction
    expect(labels).toContain("create:POST /venues")
    expect(labels).toContain("create-conflict:POST /venues")
    expect(labels).toContain("create-bound:capacity")
    expect(labels).toContain("get-unknown:GET /venues/{id}")
    expect(labels).toContain("update:PATCH /venues/{id}")
    expect(labels).toContain("delete:DELETE /venues/{id}")
    expect(labels).toContain("transition:POST /venues/{id}/open")
    expect(labels).toContain("transition-wrong-state:POST /venues/{id}/open")
    expect(labels).toContain("transition-guard:POST /venues/{id}/open")
    expect(labels).toContain("transition-unknown:POST /venues/{id}/open")
    // author examples reuse the same triple form in-loop
    expect(labels).toContain("example:venue-open")
    expect(labels).toContain("example:venue-open-small-capacity-rejected")
    // every triple is deterministic data: labels are unique
    expect(new Set(labels).size).toBe(labels.length)
  })

  it("reject unresolvable or unsatisfiable examples at spec check", async () => {
    const result = await compile("examples/bounds/invalid-example.spec.ts", { projectRoot: ROOT })
    expect(result.ok).toBe(false)
    const codes = result.diagnostics.filter((d) => d.level === "error").map((d) => d.code)
    expect(codes).toContain("EXAMPLE_TARGET_UNRESOLVED")
    expect(codes).toContain("EXAMPLE_INPUT_INCOMPLETE")
    expect(codes).toContain("EXAMPLE_FIELD_UNKNOWN")
    expect(codes).toContain("EXAMPLE_SUBJECT_INVALID")
    // v2 rejections: binding type mismatch, undeclared binding, incomplete
    // exact body, and outbox fields outside the fixture entity.
    expect(codes).toContain("EXAMPLE_BINDING_TYPE_MISMATCH")
    expect(codes).toContain("EXAMPLE_BINDING_UNKNOWN")
    expect(codes).toContain("EXAMPLE_EXPECT_INCOMPLETE")
    expect(codes).toContain("EXAMPLE_STATE_INVALID")
  })
})
