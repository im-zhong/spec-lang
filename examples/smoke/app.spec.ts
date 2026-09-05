import { defineApp } from "@spec/core"
import {
  count,
  crud,
  effect,
  entity,
  expr,
  field,
  invariant,
  lifecycle,
  transition,
} from "@spec/web"
import { auth, password } from "@spec/auth"
import { postgres } from "@spec/postgres"
import { cache } from "@spec/cache"
import { redis } from "@spec/redis"
import { message, queue } from "@spec/messaging"
import { rabbitmq } from "@spec/rabbitmq"
import { blob } from "@spec/blob"
import { s3 } from "@spec/s3"
import { NOT_NULL, example, fixture, op } from "@spec/test"
import { fastapi } from "@spec/fastapi"

/**
 * Smoke — the minimal spec that touches EVERY feature of the current
 * language in one local `--shots 1` generation:
 *
 *   fields: every type (uuid/email/string/int/boolean/datetime/ref/enum)
 *           × every modifier (unique/optional/default/min/max/maxLength)
 *   services: full CRUD (public), partial CRUD (protected, no update),
 *             principal with register-only CRUD, count endpoints
 *   auth: password strategy, 401/404/409 error contract
 *   lifecycle: requestTime guard + set + emit (confirm),
 *              const guard violable under bounds (cancel)
 *   invariants: crossRowCount (no-overbooking) + rowCheck (banned name)
 *   infra: cache (redis, bypass, stampede), messaging (rabbitmq,
 *          at-most-once queue + message), blob (s3, pdf invoices)
 *   @spec/test: subset/exact creates, invariant 409 + rollback delta,
 *               transition happy/past-time/zero-seats, delete delta
 *
 * Container lowering is compiler-side and deliberately out of scope.
 */
const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
  displayName: field.string(),
  role: field.enum("operator", "viewer"),
  active: field.boolean().default(true),
})

const Venue = entity("Venue", {
  id: field.uuid(),
  name: field.string().maxLength(40).unique(),
  capacity: field.int().min(1).max(3),
  kind: field.enum("hall", "room"),
})

const Booking = entity("Booking", {
  id: field.uuid(),
  user: field.ref("User"),
  venue: field.ref("Venue"),
  startsAt: field.datetime(),
  seats: field.int().min(0).max(9),
  notes: field.string().maxLength(120).optional(),
  status: field.enum("pending", "confirmed", "cancelled"),
  confirmedAt: field.datetime().optional(),
})

const MainAuth = auth({
  principal: User,
  strategy: password({ identity: User.fields.email }),
})

const Users = crud(User, { methods: ["list", "get"] })
const Venues = crud(Venue, { auth: false })
const VenueCount = count(Venue, { auth: false })
const Bookings = crud(Booking, { methods: ["list", "get", "create", "delete"] })
const BookingCount = count(Booking)

const BookingFlow = lifecycle(Booking, {
  field: "status",
  initial: "pending",
  transitions: [
    transition("confirm", {
      from: ["pending"],
      to: "confirmed",
      guard: expr.field("startsAt").gt(expr.request.time()),
      effects: [
        effect.set("confirmedAt", expr.request.time()),
        effect.emit("booking.confirmed", ["id", "venue", "startsAt"]),
      ],
    }),
    transition("cancel", {
      from: ["pending", "confirmed"],
      to: "cancelled",
      guard: expr.field("seats").gte(expr.const(1)),
    }),
  ],
})

const NoOverbooking = invariant("no-overbooking", {
  on: Venue,
  check: expr.countOf(Booking, { venue: "self" }).lte(expr.field("capacity")),
})

const VenueNameAllowed = invariant("venue-name-allowed", {
  on: Venue,
  check: expr.field("name").neq(expr.const("forbidden")),
})

const MainRedis = redis({ urlEnv: "SMOKE_REDIS_URL" })
const SessionCache = cache({
  provider: MainRedis,
  keyPrefix: "smoke:session",
  ttlSeconds: 60,
  failureMode: "bypass",
  stampedeProtection: true,
})

const BookingConfirmed = message("BookingConfirmed", {
  fields: { bookingId: "uuid", venueId: "uuid", occurredAt: "datetime" },
})
const Rabbit = rabbitmq({ urlEnv: "SMOKE_RABBITMQ_URL", prefetch: 8 })
const BookingEvents = queue("BookingEvents", {
  provider: Rabbit,
  messages: [BookingConfirmed],
  delivery: "at-most-once",
})

const MainS3 = s3({
  regionEnv: "AWS_REGION",
  endpointUrlEnv: "SMOKE_S3_ENDPOINT_URL",
  forcePathStyle: true,
})
const Invoices = blob("Invoices", {
  provider: MainS3,
  bucket: "smoke-invoices",
  keyPrefix: "invoices",
  maxBytes: 1048576,
  contentTypes: ["application/pdf"],
  signedUrlTtlSeconds: 300,
})

/* ---- author examples: the input→output contract, compiled to frozen tests ---- */

const VenueCreate = example("venue-create", {
  on: op(Venues, "create"),
  input: { name: "main-hall", capacity: 2, kind: "hall" },
  expect: { status: 201, body: { name: "main-hall", capacity: 2, kind: "hall" } },
})

const VenueCreateExact = example("venue-create-exact", {
  on: op(Venues, "create"),
  input: { name: "annex", capacity: 1, kind: "room" },
  expect: {
    status: 201,
    match: "exact",
    body: { id: NOT_NULL, name: "annex", capacity: 1, kind: "room" },
    state: { counts: [{ entity: Venue, delta: 1 }] },
  },
})

// rowCheck invariant: the banned name answers 409 and rolls back.
const VenueForbiddenName = example("venue-forbidden-name-rejected", {
  on: op(Venues, "create"),
  input: { name: "forbidden", capacity: 2, kind: "hall" },
  expect: {
    status: 409,
    body: { detail: "Invariant violated" },
    state: { counts: [{ entity: Venue, delta: 0 }] },
  },
})

// Declared bounds are validation: max+1 answers the default 422.
const VenueCapacityBound = example("venue-capacity-bound-rejected", {
  on: op(Venues, "create"),
  input: { name: "tight", capacity: 4, kind: "hall" },
  expect: { status: 422 },
})

const BookingCreate = example("booking-create", {
  on: op(Bookings, "create"),
  given: [
    fixture(User, { as: "u" }),
    fixture(Venue, { as: "v", fields: { capacity: 2 } }),
  ],
  input: { user: "$u", venue: "$v", startsAt: "2100-01-01T12:00:00", seats: 2 },
  expect: { status: 201, body: { status: "pending", seats: 2, venue: "$v" } },
})

const BookingConfirm = example("booking-confirm", {
  on: op(BookingFlow, "confirm"),
  subject: "$b",
  given: [
    fixture(Venue, { as: "v", fields: { capacity: 2 } }),
    fixture(Booking, {
      as: "b",
      fields: { venue: "$v", startsAt: "2100-01-01T12:00:00", seats: 2 },
    }),
  ],
  expect: {
    status: 200,
    body: { status: "confirmed", confirmedAt: NOT_NULL },
    state: { outbox: [{ event: "booking.confirmed", from: "$b", fields: ["id", "venue", "startsAt"] }] },
  },
})

// requestTime guard, fail direction: a past start answers 409 and rolls back.
const BookingConfirmPast = example("booking-confirm-past-rejected", {
  on: op(BookingFlow, "confirm"),
  subject: "$late",
  given: [
    fixture(Venue, { as: "v2", fields: { capacity: 2 } }),
    fixture(Booking, {
      as: "late",
      fields: { venue: "$v2", startsAt: "2000-01-01T12:00:00", seats: 1 },
    }),
  ],
  expect: {
    status: 409,
    body: { detail: "Invalid state" },
    state: { counts: [{ entity: Booking, delta: 0 }] },
  },
})

// const guard, fail direction: a zero-seat booking cannot be cancelled.
const BookingCancelZeroSeats = example("booking-cancel-zero-seats-rejected", {
  on: op(BookingFlow, "cancel"),
  subject: "$zero",
  given: [
    fixture(Venue, { as: "v3", fields: { capacity: 2 } }),
    fixture(Booking, {
      as: "zero",
      fields: { venue: "$v3", startsAt: "2100-01-01T12:00:00", seats: 0 },
    }),
  ],
  expect: { status: 409, body: { detail: "Invalid state" } },
})

const VenueDelete = example("venue-delete", {
  on: op(Venues, "delete"),
  subject: "$d",
  given: [fixture(Venue, { as: "d", fields: { capacity: 2 } })],
  expect: { status: 204, state: { counts: [{ entity: Venue, delta: -1 }] } },
})

const MainDB = postgres({ entities: [User, Venue, Booking] })

const services = [
  MainAuth, Users, Venues, VenueCount, Bookings, BookingCount, BookingFlow,
  NoOverbooking, VenueNameAllowed,
  SessionCache, BookingEvents, Invoices,
  VenueCreate, VenueCreateExact, VenueForbiddenName, VenueCapacityBound,
  BookingCreate, BookingConfirm, BookingConfirmPast, BookingCancelZeroSeats,
  VenueDelete,
]

const Server = fastapi({
  title: "Smoke API",
  services,
  resources: [MainDB, MainRedis, Rabbit, MainS3],
})

export default defineApp({
  name: "SmokeAPI",
  entities: [User, Venue, Booking],
  services,
  resources: [MainDB, Server],
})
