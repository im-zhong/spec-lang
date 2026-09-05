import { defineApp } from "@spec/core"
import { crud, effect, entity, expr, field, lifecycle, transition } from "@spec/web"
import { ANY, NOT_NULL, example, fixture, op } from "@spec/test"
import { postgres } from "@spec/postgres"
import { fastapi } from "@spec/fastapi"

/**
 * Bounds + examples fixture.
 *
 * Bounds are declared VALIDATION, deliberately distinct from invariant
 * semantics: int min/max and string maxLength answer the default 422 at
 * the pydantic layer, never the 409 invariant body. The shapes exercise
 * every sampler branch: capacity clamps 42 to the inclusive max edge (10)
 * with a distinct in-bounds update value (7); seats clamps both samplers
 * to the same edge (min 0 / max 2); name is unique + maxLength so samples
 * are uuid-hex slices; label truncates "sample-label" to 10.
 *
 * The examples below are author-declared input→output contracts: the
 * compiler lowers them into frozen conformance tests — literal in, pinned
 * status + body subset out, no sampling involved.
 */
const Venue = entity("Venue", {
  id: field.uuid(),
  name: field.string().maxLength(8).unique(),
  capacity: field.int().min(1).max(10),
  state: field.enum("draft", "open", "closed"),
})

const Room = entity("Room", {
  id: field.uuid(),
  label: field.string().maxLength(10),
  seats: field.int().min(0).max(2),
  active: field.boolean(),
})

const Venues = crud(Venue, { auth: false })
const Rooms = crud(Room, { auth: false })

// Opening requires capacity > 5: small venues answer the pinned 409.
// Emitting an event makes the outbox part of the observable world.
const VenueFlow = lifecycle(Venue, {
  field: "state",
  initial: "draft",
  transitions: [
    transition("open", {
      from: ["draft"],
      to: "open",
      guard: expr.field("capacity").gt(expr.const(5)),
      effects: [effect.emit("venue.opened", ["id", "name"])],
    }),
    transition("close", {
      from: ["open"],
      to: "closed",
    }),
  ],
})

const CreateExample = example("venue-create", {
  on: op(Venues, "create"),
  input: { name: "hall", capacity: 7 },
  expect: { status: 201, body: { name: "hall", capacity: 7, state: "draft" } },
})

// Exact match pins the full response key set; NOT_NULL covers the
// server-generated id, and the count delta pins the world effect.
const CreateExactExample = example("venue-create-exact", {
  on: op(Venues, "create"),
  input: { name: "annex", capacity: 6 },
  expect: {
    status: 201,
    match: "exact",
    body: { id: NOT_NULL, name: "annex", capacity: 6, state: "draft" },
    state: { counts: [{ entity: Venue, delta: 1 }] },
  },
})

const OpenExample = example("venue-open", {
  on: op(VenueFlow, "open"),
  subject: "$v",
  given: [fixture(Venue, { as: "v", fields: { capacity: 7 } })],
  expect: {
    status: 200,
    body: { state: "open", id: ANY },
    state: { outbox: [{ event: "venue.opened", from: "$v", fields: ["id", "name"] }] },
  },
})

// The rejected transition must roll back: the venue row count is unchanged.
const OpenSmallCapacityExample = example("venue-open-small-capacity-rejected", {
  on: op(VenueFlow, "open"),
  subject: "$tight",
  given: [fixture(Venue, { as: "tight", fields: { capacity: 1 } })],
  expect: {
    status: 409,
    body: { detail: "Invalid state" },
    state: { counts: [{ entity: Venue, delta: 0 }] },
  },
})

const DeleteExample = example("venue-delete", {
  on: op(Venues, "delete"),
  subject: "$d",
  given: [fixture(Venue, { as: "d", fields: { capacity: 7 } })],
  expect: {
    status: 204,
    state: { counts: [{ entity: Venue, delta: -1 }] },
  },
})

const DB = postgres({ entities: [Venue, Room] })
const services = [Venues, Rooms, VenueFlow, CreateExample, CreateExactExample, OpenExample, OpenSmallCapacityExample, DeleteExample]
const Server = fastapi({
  title: "Bounds API",
  services,
  resources: [DB],
})

export default defineApp({
  name: "BoundsAPI",
  entities: [Venue, Room],
  services,
  resources: [DB, Server],
})
