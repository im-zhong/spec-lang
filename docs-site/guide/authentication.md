# Authentication

The `@spec/auth` package describes authentication services. In the MVP it
*specifies* auth semantics — it does not implement a login system.

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
