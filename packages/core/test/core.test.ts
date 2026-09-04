import { describe, expect, it } from "vitest"
import {
  clauseId,
  clauseTable,
  constraint,
  defineApp,
  isFieldRef,
  isNodeBuilder,
  nodeId,
  ref,
  serializeValue,
  fieldRef,
  toReference,
  type ContractClause,
} from "../src"

describe("@spec/core types and DSL", () => {
  it("defineApp produces an app node builder", () => {
    const app = defineApp({ name: "Demo" })
    expect(isNodeBuilder(app)).toBe(true)
    expect(app.kind).toBe("app")
    expect(app.package).toBe("@spec/core")
    expect(app.attributes.name).toBe("Demo")
  })

  it("defineApp collects entity collections as children and name lists", () => {
    const app = defineApp({ name: "Demo", entities: [], services: [], resources: [] })
    expect(app.children).toEqual([])
    expect(app.attributes.entities).toEqual([])
  })

  it("defineApp rejects non-node collections", () => {
    expect(() =>
      defineApp({ name: "Demo", entities: [{ not: "a node" }] as never }),
    ).toThrow(TypeError)
  })

  it("ref() creates references by node id", () => {
    expect(ref("entity:User")).toEqual({ nodeId: "entity:User" })
    expect(ref({ kind: "entity", name: "User" })).toEqual({ nodeId: "entity:User" })
  })

  it("constraint() carries kind, value and message", () => {
    expect(constraint("max-length", 10, "short")).toEqual({
      kind: "max-length",
      value: 10,
      message: "short",
    })
  })

  it("nodeId is deterministic", () => {
    expect(nodeId("entity", "User")).toBe("entity:User")
    expect(nodeId("entity", "User")).toBe(nodeId("entity", "User"))
  })

  it("toReference derives node ids from kind+name", () => {
    const app = defineApp({ name: "Demo" })
    expect(toReference(app)).toEqual({ nodeId: "app:Demo" })
  })

  it("fieldRef markers are recognized", () => {
    const f = fieldRef("User", "email", "entity:User", true)
    expect(isFieldRef(f)).toBe(true)
    expect(isFieldRef({})).toBe(false)
  })

  it("serializeValue is key-sorted, drops functions and flattens field specs", () => {
    const value = {
      b: 1,
      a: { y: [1, 2], x: "s" },
      fn: () => 1,
      f: { __specFieldSpec: true, type: "email", uniqueFlag: true, unique: () => 1 },
    }
    expect(JSON.stringify(serializeValue(value))).toBe(
      JSON.stringify({ a: { x: "s", y: [1, 2] }, b: 1, f: { type: "email", unique: true } }),
    )
  })
})

describe("clause tables", () => {
  const clause = (id: string, overrides: Partial<ContractClause> = {}): ContractClause => ({
    id,
    statement: `statement for ${id}`,
    node: "router:Booking",
    kind: "route",
    verification: "oracle",
    level: "api",
    ...overrides,
  })

  it("clauseId joins stable identifier parts and keeps route ids verbatim", () => {
    expect(clauseId("route", "POST /api/posts")).toBe("route:POST /api/posts")
    expect(clauseId("entity", "Booking", "column", "startsAt")).toBe("entity:Booking:column:startsAt")
    expect(clauseId("invariant:no-overbooking")).toBe("invariant:no-overbooking")
  })

  it("clauseId rejects empty and whitespace-only parts", () => {
    expect(() => clauseId()).toThrow("at least one part")
    expect(() => clauseId("route", " ")).toThrow("cannot be empty")
  })

  it("clauseTable sorts by id and stamps the schema version", () => {
    const table = clauseTable("router:Booking", [clause("route:POST /bookings"), clause("abi:x")])
    expect(table.schemaVersion).toBe("spec-clause-table/0.1")
    expect(table.node).toBe("router:Booking")
    expect(table.clauses.map((c) => c.id)).toEqual(["abi:x", "route:POST /bookings"])
  })

  it("clauseTable rejects duplicate ids, foreign nodes, and empty statements", () => {
    expect(() => clauseTable("router:Booking", [clause("a"), clause("a")])).toThrow("duplicate id a")
    expect(() => clauseTable("router:Booking", [clause("a", { node: "app" })])).toThrow("declares node")
    expect(() => clauseTable("router:Booking", [clause("a", { statement: " " })])).toThrow("empty statement")
    expect(() => clauseTable("  ", [])).toThrow("non-empty node id")
  })
})
