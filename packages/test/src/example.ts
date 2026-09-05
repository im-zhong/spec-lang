/**
 * Example test vocabulary — the strongest contract an author can declare:
 * a concrete input that must produce a concrete output.
 *
 *   example("venue-create", {
 *     on: op(Venues, "create"),
 *     input: { name: "main-hall", capacity: 7 },
 *     expect: { status: 201, body: { name: "main-hall", capacity: 7 } },
 *   })
 *
 *   example("open-zero-capacity-rejected", {
 *     on: op(VenueFlow, "open"),
 *     subject: "$v",
 *     given: [fixture(Venue, { as: "v", fields: { capacity: 0 } })],
 *     expect: { status: 409 },
 *   })
 *
 * Pure data, like every other vocabulary node: the compiler validates it at
 * `spec check` and lowers it mechanically into frozen conformance bytes —
 * an agent never authors test code. Fixture `fields` are OVERRIDES over the
 * compiler-synthesized valid body (world-building); `input` is the literal
 * contract body and is sent exactly as written. `expect.body` matches by
 * subset: keys the author did not pin stay free (the rule-derived tests
 * already assert the exact response key set). `$name` strings reference a
 * fixture row (its id, for ref fields and `subject`).
 *
 * The expectation language: body values are literals, `$binding` row-id
 * references, or the closed predicates NOT_NULL / ANY. `match: "exact"`
 * additionally pins the full response key set (every field must appear,
 * with a predicate for server-generated values). `state` asserts what the
 * request did to the WORLD, not just the response: outbox event rows
 * (event name + payload fields, sourced from a fixture row) and per-table
 * row-count deltas measured around the request.
 */
import {
  isNodeBuilder,
  nodeBuilder,
  serializeValue,
  toReference,
  type SpecNodeBuilder,
} from "@spec/core"

/** Reference one served operation: a crud method or a lifecycle event. */
export function op(service: unknown, selector: string): { __exampleOp: true; service: unknown; selector: string } {
  return { __exampleOp: true, service, selector }
}

/** Declare one world row: `fields` override the synthesized valid body. */
export function fixture(
  entity: unknown,
  input: { as: string; fields?: Record<string, unknown> },
): { __exampleFixture: true; entity: unknown; as: string; fields?: Record<string, unknown> } {
  return { __exampleFixture: true, entity, as: input?.as, fields: input?.fields }
}

/**
 * Expectation predicates — the ONLY non-literal values allowed in
 * expect.body. Closed vocabulary, lowered mechanically:
 *
 *   NOT_NULL  the key is present with a non-null value (id, timestamps)
 *   ANY       the key is present; its value is free
 */
export const NOT_NULL = { __expect: "notNull" } as const
export const ANY = { __expect: "any" } as const

export type ExpectPredicate = typeof NOT_NULL | typeof ANY

export function isExpectPredicate(value: unknown): value is ExpectPredicate {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as Record<string, unknown>).__expect === "notNull" ||
      (value as Record<string, unknown>).__expect === "any")
  )
}

export interface ExampleInput {
  on?: unknown
  subject?: unknown
  given?: unknown
  input?: unknown
  expect?: unknown
  [key: string]: unknown
}

export function isExampleOp(value: unknown): value is { __exampleOp: true; service: unknown; selector: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__exampleOp === true
  )
}

export function isExampleFixture(
  value: unknown,
): value is { __exampleFixture: true; entity: unknown; as: string; fields?: Record<string, unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__exampleFixture === true
  )
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function example(name: string, input: ExampleInput): SpecNodeBuilder {
  const attributes: Record<string, unknown> = {}
  const on = input?.on
  if (isExampleOp(on)) {
    attributes.target = {
      service:
        isNodeBuilder(on.service) && on.service.name !== undefined
          ? toReference(on.service)
          : serializeValue(on.service),
      selector: on.selector,
    }
  } else {
    attributes.target = serializeValue(on)
  }
  if (input?.subject !== undefined) attributes.subject = input.subject
  if (Array.isArray(input?.given)) {
    attributes.given = input.given.map((item) =>
      isExampleFixture(item)
        ? {
            entity:
              isNodeBuilder(item.entity) && item.entity.name !== undefined
                ? toReference(item.entity)
                : serializeValue(item.entity),
            as: item.as,
            ...(item.fields === undefined ? {} : { fields: item.fields }),
          }
        : serializeValue(item),
    )
  }
  if (input?.input !== undefined) attributes.input = input.input
  if (isPlainObject(input?.expect)) {
    const expect = { ...(input.expect as Record<string, unknown>) }
    // state.counts entries may carry entity builders — normalize to refs.
    const state = expect.state
    if (isPlainObject(state) && Array.isArray(state.counts)) {
      expect.state = {
        ...state,
        counts: state.counts.map((entry) =>
          isPlainObject(entry) && isNodeBuilder(entry.entity) && entry.entity.name !== undefined
            ? { ...entry, entity: toReference(entry.entity) }
            : entry,
        ),
      }
    }
    attributes.expect = expect
  } else {
    attributes.expect = input?.expect
  }
  return nodeBuilder("@spec/test", "example", name, attributes)
}
