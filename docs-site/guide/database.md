# Databases

The `@spec/postgres` package describes a PostgreSQL resource. In the MVP
it *specifies* the database — which entities live in it, and what
capabilities it provides — without creating or connecting to a real
database.

## Declaring a database resource

```ts
import { entity, field } from "@spec/web"
import { postgres } from "@spec/postgres"

const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
})

const MainDB = postgres({
  entities: [User],
})
```

The IR node:

```json
{
  "id": "postgres:MainDB",
  "kind": "postgres",
  "package": "@spec/postgres",
  "attributes": {
    "entities": [{ "nodeId": "entity:User" }],
    "provides": ["RelationalStore"]
  }
}
```

## Capabilities

Resources are the *providers* side of the capability system:

```
Auth package              Postgres package
     │                          │
     │  requires                │  provides
     ▼                          ▼
  RelationalStore  ◄────────────┘
```

- `@spec/auth` nodes declare `requires: ["RelationalStore"]`
- `@spec/postgres` nodes declare `provides: ["RelationalStore"]`
- The compiler's **link pass** matches requirements against providers

Two checks are performed:

**Missing provider** (error)

```
MISSING_CAPABILITY_PROVIDER — "auth:MainAuth" requires capability
"RelationalStore" but no spec node provides it.
```

**Duplicate providers** (warning)

```
DUPLICATE_CAPABILITY_PROVIDER — Capability "RelationalStore" is provided
by multiple nodes: postgres:MainDB, postgres:BackupDB.
```

The compiled IR records both sides:

```json
"capabilities": {
  "provided": [
    { "capability": "RelationalStore", "provider": "postgres:MainDB" }
  ],
  "required": [
    { "capability": "RelationalStore", "requester": "auth:MainAuth" }
  ]
}
```

## A complete application

User + auth + database is the canonical shape of an MVP application:

```ts
import { defineApp } from "@spec/core"
import { entity, field } from "@spec/web"
import { auth, password } from "@spec/auth"
import { postgres } from "@spec/postgres"

const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
  name: field.string(),
})

const MainAuth = auth({
  principal: User,
  strategy: password({ identity: User.fields.email }),
})

const MainDB = postgres({ entities: [User] })

export default defineApp({
  name: "ExampleApp",
  entities: [User],
  services: [MainAuth],
  resources: [MainDB],
})
```

Compile it with `spec build` and you get a complete, deterministic
description of the application's data model, auth semantics and storage —
see [The application root](/guide/app-root) for how the pieces are
assembled.
