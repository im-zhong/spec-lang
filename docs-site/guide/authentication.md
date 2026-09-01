# Authentication

The `@spec/auth` package describes authentication services. Statically it
*specifies* auth semantics; when served by a
[`fastapi()`](/guide/generate) server, `spec generate` **implements** the
whole flow.

## Declaring an auth service

```ts
import { entity, field } from "@spec/web"
import { auth, password } from "@spec/auth"

const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
})

const MainAuth = auth({
  principal: User,
  strategy: password({
    identity: User.fields.email,
  }),
})
```

- **`principal`** — the entity that represents a logged-in user. Must be
  an entity node, passed directly (not as a string).
- **`strategy`** — how credentials are checked. `password(...)` declares a
  password strategy bound to an **identity field** of the principal.

Like all anonymous builders, the auth node adopts its const name:

```json
{
  "id": "auth:MainAuth",
  "kind": "auth",
  "package": "@spec/auth",
  "attributes": {
    "principal": { "nodeId": "entity:User" },
    "requires": ["RelationalStore"]
  },
  "children": [
    {
      "id": "passwordStrategy:auth:MainAuth#0",
      "kind": "passwordStrategy",
      "attributes": {
        "identity": {
          "__fieldRef": true,
          "entity": "User",
          "field": "email",
          "owner": "entity:User"
        }
      }
    }
  ]
}
```

## Semantic rules

The auth package registers validators that the compiler runs on every
build. Four rules, each with its own diagnostic code:

### 1. The principal must be an entity

```ts
const MainAuth = auth({ principal: "User" }) // ✗ a string, not an entity
```

```
AUTH_PRINCIPAL_INVALID — Auth principal must be an entity (received the
string "User").
```

Passing a non-entity node produces `AUTH_PRINCIPAL_NOT_ENTITY`.

### 2. The identity must belong to the principal

```ts
const Product = entity("Product", { id: field.uuid() })

const MainAuth = auth({
  principal: User,
  strategy: password({ identity: Product.fields.id }), // ✗ different entity
})
```

```
AUTH_IDENTITY_NOT_IN_PRINCIPAL — Auth identity Product.id does not belong
to principal entity "User".
```

Referencing a field that does not exist on the principal produces the same
code.

### 3. The identity should be unique (warning)

```ts
const User = entity("User", {
  id: field.uuid(),
  email: field.email(), // ✗ forgot .unique()
})

const MainAuth = auth({
  principal: User,
  strategy: password({ identity: User.fields.email }),
})
```

```
AUTH_IDENTITY_NOT_UNIQUE (warning) — Authentication identity User.email
should be unique.
```

This is a **warning**, not an error: the spec compiles (`spec check`
still exits 0), but the report tells you about the smell. This is the
error/warning distinction in action — errors block, warnings inform.

## Capability requirement

An auth service needs somewhere to store users. The auth node carries:

```json
"requires": ["RelationalStore"]
```

If no node in the application provides `RelationalStore` (for example,
you forgot to add a database resource), the compiler's link pass reports:

```
MISSING_CAPABILITY_PROVIDER — "auth:MainAuth" requires capability
"RelationalStore" but no spec node provides it.
```

Add a `postgres` resource (see [Databases](/guide/database)) to satisfy
it. This is the capability system working across packages: `@spec/auth`
and `@spec/postgres` know nothing about each other — the compiler
connects them.

## Generated auth behavior

When an auth service is served (`fastapi({ services: [MainAuth, ...])`),
the blueprint derives three routes, all pinned:

| Route | Request | Success | Failure |
| ----- | ------- | ------- | ------- |
| `POST <prefix>/auth/register` | principal fields + `password` | `201` principal row (never the hash) | `409 {"detail": "Already exists"}` on duplicate identity |
| `POST <prefix>/auth/login` | `{ <identityField>, password }` | `200 { "access_token": "…", "token_type": "bearer" }` | `401 {"detail": "Invalid credentials"}` |
| `GET <prefix>/auth/me` | bearer token | `200` principal row | `401 {"detail": "Not authenticated"}` |

Implementation details the compiler pins (and the conformance suite
asserts):

- passwords are stored **bcrypt-hashed** in an implicit `password_hash`
  column that never appears in any response
- tokens are **JWT bearer** tokens; every `crud`/`count` route with
  `auth: true` (the default) requires one
- wrong password and unknown identity answer identically — no user
  enumeration
- the principal must not carry `ref` fields
  (`FASTAPI_PRINCIPAL_REF_UNSUPPORTED`): register creates principals
  standalone and cannot seed references

Serve the auth service to *activate* route protection — in its absence
every route in the app is public. See
[the blueprint reference](/reference/blueprint#auth) for the exact
contract data.
