/**
 * INVALID fixture (compiled only by tests): every example below violates
 * the @spec/test contract and must be rejected at `spec check` — an
 * unresolvable or unsatisfiable example is an authoring error, never
 * something generation may discover.
 */
import { defineApp } from "@spec/core"
import { crud, entity, field } from "@spec/web"
import { NOT_NULL, example, fixture, op } from "@spec/test"
import { postgres } from "@spec/postgres"
import { fastapi } from "@spec/fastapi"

const Box = entity("Box", { id: field.uuid(), label: field.string(), units: field.int() })
const Crate = entity("Crate", { id: field.uuid(), box: field.ref("Box"), tag: field.string() })
const Boxes = crud(Box, { methods: ["list", "get", "create", "update"], auth: false })
const Crates = crud(Crate, { auth: false })

const BadMethod = example("bad-method", { on: op(Boxes, "delete"), subject: "$b", given: [], expect: { status: 204 } })
const Incomplete = example("incomplete-create", { on: op(Boxes, "create"), input: { label: "x" }, expect: { status: 201 } })
const UnknownField = example("unknown-field", { on: op(Boxes, "create"), input: { label: "x", units: 1, weight: 2 }, expect: { status: 201 } })
const MissingSubject = example("missing-subject", { on: op(Boxes, "get"), expect: { status: 200 } })
// Binding the crate's box ref to a Crate fixture is a type mismatch.
const BadBindingType = example("bad-binding-type", {
  on: op(Crates, "create"),
  input: { box: "$c", tag: "t" },
  given: [fixture(Crate, { as: "c" })],
  expect: { status: 201 },
})
// expect.body references a fixture nobody declared.
const UnknownBinding = example("unknown-binding", {
  on: op(Boxes, "create"),
  input: { label: "x", units: 1 },
  expect: { status: 201, body: { label: "$ghost" } },
})
// Exact match must pin every response field (units missing).
const InexactExact = example("inexact-exact", {
  on: op(Boxes, "create"),
  input: { label: "x", units: 1 },
  expect: { status: 201, match: "exact", body: { id: NOT_NULL, label: "x" } },
})
// outbox fields must be declared fields of the fixture's entity.
const BadOutbox = example("bad-outbox", {
  on: op(Boxes, "update"),
  subject: "$b",
  given: [fixture(Box, { as: "b", fields: { label: "x", units: 1 } })],
  input: { label: "y" },
  expect: { status: 200, state: { outbox: [{ event: "box.touched", from: "$b", fields: ["nope"] }] } },
})

const DB = postgres({ entities: [Box, Crate] })
const all = [Boxes, Crates, BadMethod, Incomplete, UnknownField, MissingSubject, BadBindingType, UnknownBinding, InexactExact, BadOutbox]
const Server = fastapi({
  title: "Invalid Examples API",
  services: all,
  resources: [DB],
})

export default defineApp({
  name: "InvalidExamplesAPI",
  entities: [Box, Crate],
  services: all,
  resources: [DB, Server],
})
