import { defineApp } from "@spec/core"
import { entity, field, crud, count, lifecycle, transition } from "@spec/web"
import { auth, password } from "@spec/auth"
import { postgres } from "@spec/postgres"
import { fastapi } from "@spec/fastapi"

/**
 * Project 3 — Booking API.
 * Purpose: reservation service with public catalog data.
 * Features: auth + mixed public/protected routes, datetime fields,
 * partial CRUD subsets (bookings have no update), count endpoint, and a
 * booking lifecycle (pending → confirmed / cancelled) — the "line" facet
 * of behavior (docs/behavior-model.md Phase 1).
 */

const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
  name: field.string(),
})

const Venue = entity("Venue", {
  id: field.uuid(),
  name: field.string().unique(),
  capacity: field.int(),
})

const Booking = entity("Booking", {
  id: field.uuid(),
  user: field.ref("User"),
  venue: field.ref("Venue"),
  startsAt: field.datetime(),
  notes: field.string().optional(),
  status: field.enum("pending", "confirmed", "cancelled"),
})

const MainAuth = auth({
  principal: User,
  strategy: password({ identity: User.fields.email }),
})

const Users = crud(User, { methods: ["list", "get"] })
const Venues = crud(Venue, { auth: false })
const Bookings = crud(Booking, { methods: ["list", "get", "create", "delete"] })
const BookingCount = count(Booking)

// Which operations are legal WHEN: transitions are operations, not prose.
const BookingFlow = lifecycle(Booking, {
  field: "status",
  initial: "pending",
  transitions: [
    transition("confirm", { from: ["pending"], to: "confirmed" }),
    transition("cancel", { from: ["pending", "confirmed"], to: "cancelled" }),
  ],
})

const MainDB = postgres({ entities: [User, Venue, Booking] })

const Server = fastapi({
  title: "Booking API",
  // The stack is part of the specification — exact pins, no floating
  // versions. (Defaults are provided by @spec/fastapi; overrides merge.)
  stack: {
    python: "3.13",
    dependencies: {
      fastapi: "0.141.1",
      sqlalchemy: "2.0.52",
      pydantic: "2.13.5",
      pyjwt: "2.13.0",
      bcrypt: "5.0.0",
    },
    dev: { pytest: "9.1.1", httpx: "0.28.1" },
  },
  services: [MainAuth, Users, Venues, Bookings, BookingCount, BookingFlow],
  resources: [MainDB],
})

export default defineApp({
  name: "BookingAPI",
  entities: [User, Venue, Booking],
  services: [MainAuth, Users, Venues, Bookings, BookingCount, BookingFlow],
  resources: [MainDB, Server],
})
