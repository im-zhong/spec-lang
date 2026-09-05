import { describe, expect, it } from "vitest"
import { crud, entity, field, lifecycle, transition } from "@spec/web"
import type { SpecNode, SpecNodeBuilder, ValidationContext } from "@spec/core"
import { ANY, NOT_NULL, example, fixture, op } from "../src"
import { validateExamples } from "../src/validators"

const Venue = entity("Venue", { id: field.uuid(), capacity: field.int() })
const Room = entity("Room", { id: field.uuid(), venue: field.ref("Venue"), tag: field.string() })
const Rooms = crud(Room, { auth: false })
const Venues = crud(Venue, { auth: false })
const Flow = lifecycle(Venue, {
  field: "state",
  initial: "draft",
  transitions: [transition("open", { from: ["draft"], to: "open" })],
})

/** Fabricate the SpecNode the pipeline would hand the validator. */
function asNode(builder: SpecNodeBuilder, id: string): SpecNode {
  return {
    id,
    kind: builder.kind,
    package: builder.package,
    ...(builder.name === undefined ? {} : { name: builder.name }),
    attributes: builder.attributes,
  } as never as SpecNode
}

const nodes = () => [
  asNode(Venue, "entity:Venue"),
  asNode(Room, "entity:Room"),
  asNode(Venues, `crud:${Venues.name ?? "Venue"}`),
  asNode(Rooms, `crud:${Rooms.name ?? "Room"}`),
  asNode(Flow, `lifecycle:${Flow.name ?? "Venue"}`),
]

function run(all: SpecNode[]) {
  return (
    validateExamples.run({
      findNodes: (kind: string) => all.filter((n) => n.kind === kind),
    } as ValidationContext) ?? []
  )
}

function exampleNode(input: Record<string, unknown>): SpecNode {
  return asNode(example("probe", input), "example:probe")
}

describe("@spec/test example vocabulary", () => {
  it("serializes op/fixture references and literals into plain attributes", () => {
    const node = example("venue-open", {
      on: op(Flow, "open"),
      subject: "$v",
      given: [fixture(Venue, { as: "v", fields: { capacity: 0 } })],
      expect: { status: 200, body: { state: "open" } },
    })
    const attrs = node.attributes as Record<string, unknown>
    const target = attrs.target as { service: { nodeId: string }; selector: string }
    expect(target.selector).toBe("open")
    expect(target.service.nodeId).toMatch(/^lifecycle:/)
    expect(attrs.subject).toBe("$v")
    expect(attrs.given).toEqual([
      { entity: { nodeId: "entity:Venue" }, as: "v", fields: { capacity: 0 } },
    ])
    expect(attrs.expect).toEqual({ status: 200, body: { state: "open" } })
  })

  it("accepts a well-formed example without diagnostics", () => {
    const ok = exampleNode({ on: op(Venues, "create"), input: { capacity: 3 }, expect: { status: 201 } })
    expect(run([...nodes(), ok])).toEqual([])
  })

  it("rejects unknown service targets, unknown fields, bad bindings, and malformed expects", () => {
    // An entity is not a service: the target must be a crud/lifecycle node.
    const notAService = exampleNode({ on: op(Venue, "create"), expect: { status: 201 } })
    expect(run([...nodes(), notAService]).map((d) => d.code)).toContain("EXAMPLE_TARGET_UNKNOWN")

    const unknownField = exampleNode({
      on: op(Venues, "create"),
      input: { capacity: 1, weight: 2 },
      expect: { status: 201 },
    })
    expect(run([...nodes(), unknownField]).map((d) => d.code)).toContain("EXAMPLE_FIELD_UNKNOWN")

    const badSubject = exampleNode({ on: op(Flow, "open"), subject: "$ghost", expect: { status: 200 } })
    expect(run([...nodes(), badSubject]).map((d) => d.code)).toContain("EXAMPLE_SUBJECT_INVALID")

    const badExpect = exampleNode({ on: op(Venues, "create"), input: { capacity: 1 }, expect: { status: "201" } })
    expect(run([...nodes(), badExpect]).map((d) => d.code)).toContain("EXAMPLE_EXPECT_INVALID")

    const duplicateBinding = exampleNode({
      on: op(Flow, "open"),
      subject: "$a",
      given: [fixture(Venue, { as: "a" }), fixture(Venue, { as: "a" })],
      expect: { status: 200 },
    })
    expect(run([...nodes(), duplicateBinding]).map((d) => d.code)).toContain("EXAMPLE_BINDING_DUPLICATE")
  })

  it("accepts predicates, exact match, and state assertions; rejects mismatches", () => {
    const ok = exampleNode({
      on: op(Flow, "open"),
      subject: "$v",
      given: [fixture(Venue, { as: "v", fields: { capacity: 7 } })],
      expect: {
        status: 200,
        match: "exact",
        body: { id: NOT_NULL, capacity: ANY },
        state: {
          outbox: [{ event: "venue.opened", from: "$v", fields: ["id", "capacity"] }],
          counts: [{ entity: Venue, delta: 1 }],
        },
      },
    })
    expect(run([...nodes(), ok])).toEqual([])

    // A ref field bound to a fixture of the wrong entity.
    const mismatch = exampleNode({
      on: op(Rooms, "create"),
      input: { venue: "$r", tag: "t" },
      given: [fixture(Room, { as: "r" })],
      expect: { status: 201 },
    })
    expect(run([...nodes(), mismatch]).map((d) => d.code)).toContain("EXAMPLE_BINDING_TYPE_MISMATCH")

    // expect.body references an undeclared binding.
    const ghost = exampleNode({
      on: op(Venues, "create"),
      input: { capacity: 1 },
      expect: { status: 201, body: { capacity: "$ghost" } },
    })
    expect(run([...nodes(), ghost]).map((d) => d.code)).toContain("EXAMPLE_BINDING_UNKNOWN")

    // Unknown match mode.
    const badMatch = exampleNode({
      on: op(Venues, "create"),
      input: { capacity: 1 },
      expect: { status: 201, match: "loose" },
    })
    expect(run([...nodes(), badMatch]).map((d) => d.code)).toContain("EXAMPLE_EXPECT_INVALID")

    // outbox field not declared on the fixture's entity.
    const badOutbox = exampleNode({
      on: op(Flow, "open"),
      subject: "$v",
      given: [fixture(Venue, { as: "v", fields: { capacity: 7 } })],
      expect: { status: 200, state: { outbox: [{ event: "x", from: "$v", fields: ["nope"] }] } },
    })
    expect(run([...nodes(), badOutbox]).map((d) => d.code)).toContain("EXAMPLE_STATE_INVALID")

    // counts must address a declared entity.
    const badCount = exampleNode({
      on: op(Venues, "create"),
      input: { capacity: 1 },
      expect: { status: 201, state: { counts: [{ entity: Venue, delta: "one" }] } },
    })
    expect(run([...nodes(), badCount]).map((d) => d.code)).toContain("EXAMPLE_STATE_INVALID")

    // NOT_NULL/ANY are the only admitted predicates.
    const badPredicate = exampleNode({
      on: op(Venues, "create"),
      input: { capacity: 1 },
      expect: { status: 201, body: { id: { __expect: "sometimes" } } },
    })
    expect(run([...nodes(), badPredicate]).map((d) => d.code)).toContain("EXAMPLE_EXPECT_INVALID")
  })
})
