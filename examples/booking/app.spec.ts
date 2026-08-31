import { defineApp } from "@spec/core"
import { entity, field, crud, count } from "@spec/web"
import { auth, password } from "@spec/auth"
import { postgres } from "@spec/postgres"
import { fastapi } from "@spec/fastapi"

/**
 * Project 3 — Booking API.
 * Purpose: reservation service with public catalog data.
 * Features: auth + mixed public/protected routes, datetime fields,
 * partial CRUD subsets (bookings have no update), count endpoint.
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
})

const MainAuth = auth({
  principal: User,
  strategy: password({ identity: User.fields.email }),
})

const Users = crud(User, { methods: ["list", "get"] })
const Venues = crud(Venue, { auth: false })
const Bookings = crud(Booking, { methods: ["list", "get", "create", "delete"] })
const BookingCount = count(Booking)

const MainDB = postgres({ entities: [User, Venue, Booking] })

const Server = fastapi({
  title: "Booking API",
  services: [MainAuth, Users, Venues, Bookings, BookingCount],
  resources: [MainDB],
})

export default defineApp({
  name: "BookingAPI",
  entities: [User, Venue, Booking],
  services: [MainAuth, Users, Venues, Bookings, BookingCount],
  resources: [MainDB, Server],
})
