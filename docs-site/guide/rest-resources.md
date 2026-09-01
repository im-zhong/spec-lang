# REST resources

The `@spec/web` package provides the HTTP vocabulary: `crud()` exposes an
entity as a RESTful resource, `count()` adds a pinned count endpoint, and
`field.ref()` connects entities. Together with
[`fastapi()`](/guide/generate) they describe a complete RESTful API server
— which `spec generate` then implements.

## CRUD resources

```ts
import { entity, field, crud } from "@spec/web"

const Post = entity("Post", {
  id: field.uuid(),
  title: field.string(),
  body: field.string().optional(),
  published: field.boolean().default(false),
})

const Posts = crud(Post)
```

`crud(Entity)` declares the five standard REST operations for that entity.
The **path defaults to the pluralized, kebab-cased entity name** —
`crud(Post)` serves `/posts`, `crud(BlogPost)` serves `/blog-posts`,
`crud(Category)` serves `/categories`.

The derived routes (what a generated backend must expose, exactly):

| Operation | Route | Success | Body |
| --------- | ----- | ------- | ---- |
| `list`    | `GET /posts` | `200` | bare JSON array — **every** row, in creation order |
| `get`     | `GET /posts/{id}` | `200` | the row |
| `create`  | `POST /posts` | `201` | the stored row |
| `update`  | `PATCH /posts/{id}` | `200` | the updated row (partial) |
| `delete`  | `DELETE /posts/{id}` | `204` | empty |

`list` has **no requester filtering**: it returns every row of the entity,
including the requesting principal when the listed entity is the
principal (the blueprint's `listScope: "allRows"` pin).

### Options

```ts
const Posts = crud(Post, {
  path: "/articles",                     // custom path
  methods: ["list", "get"],              // subset of the five operations
  auth: false,                           // public (default: protected)
})
```

| Option    | Type                                   | Default            |
| --------- | -------------------------------------- | ------------------ |
| `path`    | `string`                               | `/` + plural name  |
| `methods` | `Array<"list" \| "get" \| "create" \| "update" \| "delete">` | all five |
| `auth`    | `boolean`                              | `true`             |

`auth: true` means the routes require a bearer token **when the app has an
auth service** — in a spec without auth, every route is public (the
requirement is simply unsatisfiable otherwise, so the compiler drops it).

Method subsets are how read-only or append-only resources are expressed.
The booking example exposes bookings without update:

```ts
const Bookings = crud(Booking, { methods: ["list", "get", "create", "delete"] })
```

### The IR node

```json
{
  "id": "crud:Post",
  "kind": "crud",
  "package": "@spec/web",
  "attributes": {
    "entity": { "nodeId": "entity:Post" },
    "path": "/posts",
    "auth": true
  }
}
```

The node references its entity by deterministic node id — which is why
`crud()` must receive the **entity builder itself**, not a string.

## References between entities

`field.ref("Target")` declares a foreign-key field:

```ts
const Post = entity("Post", {
  id: field.uuid(),
  title: field.string(),
  author: field.ref("User"),      // → users table
})

const Comment = entity("Comment", {
  id: field.uuid(),
  body: field.string(),
  post: field.ref("Post"),        // refs can chain: comment → post → user
  author: field.ref("User"),
})
```

Reference fields behave like the other field types — they chain
(`field.ref("User").optional()`), validate, and serialize. The pinned
semantics for generated backends:

- **requests**: a `ref` field carries the referenced row's `id` (string)
- **responses**: it serializes as that `id` string, unchanged
- **integrity**: creating or updating with a `ref` that points at a
  nonexistent row is `404 {"detail": "Not found"}` — the same body as any
  other missing resource
- columns use snake_case (`author` → `author` column of `user` id type);
  table names are snake_case plurals (`User` → `users`)

The target of a `ref` must be an entity defined in the same specification:

```
FIELD_REF_TARGET_UNKNOWN — Field "Post.author" references unknown entity
"Usr".
```

## Count endpoints

`count(Entity)` adds a read-only endpoint with pinned semantics —
`GET <path>` returns `200 {"count": <int>}` (total rows):

```ts
import { count } from "@spec/web"

const BookingCount = count(Booking)                    // GET /bookings/count
const ProductCount = count(Product, {                  // custom path, public
  path: "/api/v1/catalog/size",
  auth: false,
})
```

Counts are the one *custom* endpoint with pinned behavior, which is what
makes them safe to generate repeatably. Register a count route **before**
any `{id}` route of the same prefix — the generated backend does this;
`/posts/count` must not be captured by `GET /posts/{id}`.

::: warning
The generic `api({...})` builder still exists as vocabulary, but
`@spec/fastapi` refuses to lower it — only `count()` has pinned semantics.
Serving a generic `api()` node reports `FASTAPI_API_OPERATION_UNSUPPORTED`.
:::

## Validation rules

The web validators check every crud/count node at compile time:

| Diagnostic                 | Trigger                                              |
| -------------------------- | ---------------------------------------------------- |
| `CRUD_TARGET_INVALID`      | `crud()` target is not an entity builder             |
| `CRUD_ENTITY_NOT_FOUND`    | target entity is not defined in the spec             |
| `CRUD_INVALID_PATH`        | path is not an absolute URL path                     |
| `CRUD_DUPLICATE_PATH`      | two crud resources share a path                      |
| `CRUD_METHOD_UNKNOWN`      | method outside the five operations                   |
| `CRUD_METHOD_DUPLICATE`    | repeated method in `methods`                         |
| `CRUD_NAME_MISMATCH`       | crud node renamed away from its entity (warning)     |
| `API_ENTITY_NOT_FOUND`     | `count()` target entity missing                      |
| `API_INVALID_PATH`         | `count()` path invalid                               |

## A complete resource layer

This is the resource layer of `examples/booking` — three entities, mixed
visibility, a method subset and a count:

```ts
const Users = crud(User, { methods: ["list", "get"] })   // protected, read-only
const Venues = crud(Venue, { auth: false })              // public catalog
const Bookings = crud(Booking, {                         // protected, no update
  methods: ["list", "get", "create", "delete"],
})
const BookingCount = count(Booking)
const BookingFlow = lifecycle(Booking, {                 // state machine
  field: "status",
  initial: "pending",
  transitions: [
    transition("confirm", { from: ["pending"], to: "confirmed" }),
    transition("cancel", { from: ["pending", "confirmed"], to: "cancelled" }),
  ],
})
```

Serve them with a [`fastapi()`](/guide/generate) server resource and
`spec generate` produces a backend exposing exactly:

```
GET    /users            protected
GET    /users/{id}       protected
GET    /venues           public
GET    /venues/{id}      public
POST   /venues           public
PATCH  /venues/{id}      public
DELETE /venues/{id}      public
GET    /bookings         protected
GET    /bookings/{id}    protected
POST   /bookings         protected
DELETE /bookings/{id}    protected
GET    /bookings/count   protected
POST   /bookings/{id}/confirm   protected   (pending → confirmed)
POST   /bookings/{id}/cancel    protected   (pending|confirmed → cancelled)
POST   /auth/login       public
POST   /auth/register    public
GET    /auth/me          protected
```

Seventeen routes, every status code, request/response shape, error body —
and every legal state change — decided by the specification. Continue with
[Agentic generation](/guide/generate) to see them implemented, or read
[the blueprint reference](/reference/blueprint) for the full contract.

## Lifecycles (behavior: which operations are legal *when*)

REST resources pin *what* exists. A **lifecycle** pins *when* operations
are legal — the "line" facet of behavior from
the behavior model plan in `docs/behavior-model.md` (Phase 1:
transitions without guards/effects):

```ts
import { lifecycle, transition } from "@spec/web"

const Booking = entity("Booking", {
  id: field.uuid(),
  user: field.ref("User"),
  venue: field.ref("Venue"),
  startsAt: field.datetime(),
  status: field.enum("pending", "confirmed", "cancelled"),  // the state field
})

const BookingFlow = lifecycle(Booking, {
  field: "status",        // must be an enum field of the entity
  initial: "pending",     // assigned on create
  transitions: [
    transition("confirm", { from: ["pending"], to: "confirmed" }),
    transition("cancel",  { from: ["pending", "confirmed"], to: "cancelled" }),
  ],
})
```

Serve it (`fastapi({ services: [..., BookingFlow] })`) and each transition
becomes an **operation**, lowered to an action endpoint backed by an
atomic guarded update:

| Route | Guard | Effect | Outcomes |
| ----- | ----- | ------ | -------- |
| `POST /bookings/{id}/confirm` | `status ∈ {pending}` | `status = confirmed` | `200` row · `409 {"detail": "Invalid state"}` · `404 {"detail": "Not found"}` |
| `POST /bookings/{id}/cancel` | `status ∈ {pending, confirmed}` | `status = cancelled` | same |

The guard never leaves SQL — two concurrent transitions of the same row
serialize in the database and the loser observes the pinned `409`. The
state field is **server-controlled**: it never appears in create or update
bodies (create assigns `initial`; PATCH ignores it), so state changes only
through transitions — the compiler enforces what prose usually only asks
for.

The compiler validates the machine itself, before any generation:

| Diagnostic | Meaning |
| ---------- | ------- |
| `LIFECYCLE_FIELD_INVALID` | the field is not an `enum` field of the entity |
| `LIFECYCLE_INITIAL_NOT_STATE` | `initial` is not one of the enum's states |
| `LIFECYCLE_TRANSITION_TARGET_UNKNOWN` | a `from`/`to` state is misspelled |
| `LIFECYCLE_TRANSITION_DUPLICATE` | the same `(event, from-state)` leads to two states — nondeterminism is unrepresentable |
| `LIFECYCLE_STATE_UNREACHABLE` | warning: no path from `initial` reaches the state |

And the conformance suite derives the full matrix from the same data:
every legal transition (200 + new state echoed), every illegal re-apply
(409 with the exact body), unknown ids (404), create-assigns-initial, and
update-ignores-state. Roadmap (Phase 2/3 of the behavior model):
`invariant` for cross-entity truths and `effect.set`/`effect.emit` —
every new expression must pass the SQL litmus test to enter the language.
