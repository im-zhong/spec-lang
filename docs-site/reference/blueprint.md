# Blueprint reference

The **BackendBlueprint** is the contract between the traditional compiler
half and the agentic half. It is produced by `buildBlueprint(ir)` — a
**pure, total function** of the Spec IR (`packages/fastapi/src/blueprint.ts`)
— and pins everything an HTTP client can observe. Nothing in it is an
agent decision.

```ts
import { compile } from "@spec/compiler"
import { buildBlueprint } from "@spec/fastapi"

const result = await compile("app.spec.ts", { projectRoot: process.cwd() })
const blueprint = buildBlueprint(result.ir)
```

Written verbatim to `.spec/blueprint.json` by `spec generate --dry-run`.
Determinism: the same IR always produces the same blueprint (asserted by
tests).

## Shape

```ts
interface BackendBlueprint {
  app: { name: string; title: string; version: string; prefix: string; port: number }
  entities: BlueprintEntity[]
  routes: BlueprintRoute[]
  auth?: BlueprintAuth
  database: { engine: "postgres" | "sqlite"; urlEnv: string; fallback: string; urlFormat: "sqlalchemy-url" }
  contract: BackendContract
}
```

### `entities`

```ts
interface BlueprintEntity {
  name: string                  // "BlogPost"
  table: string                 // "blog_posts" (snake_case plural)
  fields: BlueprintField[]
  passwordColumn?: string       // implicit "password_hash" on the principal
}

interface BlueprintField {
  name: string                  // JSON key, EXACTLY as declared
  column: string                // snake_case DB column
  type: "string" | "int" | "boolean" | "uuid" | "email" | "datetime" | "ref"
  target?: string               // for ref fields: referenced entity name
  unique?: boolean
  optional?: boolean
  default?: unknown
}
```

JSON keys keep the declared casing (`startsAt` stays `startsAt`); only
database identifiers are snake_cased. Two columns are implicit and never
serialized: `created_at` (orders lists) and the principal's
`password_hash`.

### `routes`

The flat, complete route table — the exact OpenAPI surface a conforming
implementation must expose.

```ts
interface BlueprintRoute {
  id: string                    // "PATCH /api/v1/posts/{id}"
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  path: string                  // prefix included, {id} path params
  operation: "list" | "get" | "create" | "update" | "delete"
            | "login" | "register" | "me" | "count"
  entity?: string
  status: number                // success status code
  auth: boolean                 // bearer token required
  request?: { shape: Record<string, string>; partial?: boolean }
  response: { kind: "entity" | "entityArray" | "empty" | "token" | "count"; entity?: string }
}
```

Derivation rules (deterministic):

| Source | Routes |
| ------ | ------ |
| `crud(E)` with `methods` | one route per method, in canonical order list/get/create/update/delete |
| `crud` `path` | default `/` + pluralized kebab-cased entity name; prefix prepended |
| `count(E)` | `GET <path>` → `200 {"count": n}` |
| `auth(password)` | `POST <prefix>/auth/login`, `POST <prefix>/auth/register`, `GET <prefix>/auth/me` |
| `crud`/`count` `auth: true` | only enforced when an auth service is actually served |

### `auth`

```ts
interface BlueprintAuth {
  strategy: "password-jwt"
  principal: string             // entity name
  identityField: string         // from password({ identity })
  passwordColumn: "password_hash"
  routes: BlueprintRoute[]      // login / register / me
}
```

### `contract` — the pinned behavior

This block is the golden rule in data form. **Every value here is law**;
the conformance suite asserts each one.

```ts
interface BackendContract {
  serialization: {
    entityKeys: "declaredFieldNames"   // JSON keys = field names as written
    refFields: "referencedIdString"    // refs serialize as the target's id
    hiddenColumns: ["password_hash", "created_at"]
    listShape: "bareArray"             // list endpoints return a plain array
    listOrder: "createdAtAscending"    // insertion order via created_at
    idGeneration: "serverUuid4"        // server-side uuid4; body id ignored
    createDefaults: "omittable-appliesDefault"
                                       // defaulted fields omittable; default
                                       // applies when omitted; optional
                                       // without default stores null
  }
  errors: {
    unauthenticated:    { status: 401; body: { detail: "Not authenticated" } }
    invalidCredentials: { status: 401; body: { detail: "Invalid credentials" } }
    notFound:           { status: 404; body: { detail: "Not found" } }
    danglingRef:        { status: 404; body: { detail: "Not found" } }
    alreadyExists:      { status: 409; body: { detail: "Already exists" } }
    validation:         { status: 422; body: "fastapi-default" }
  }
  auth: {
    scheme: "bearer-jwt"
    loginRequest: { <identityField>: "string"; password: "string" }
    registerRequest: { ...principal fields; password: "string" }
    loginResponse: { access_token: "string"; token_type: "bearer" }
  }
}
```

## Why every pin exists

Each entry in `contract` corresponds to a divergence the repeatability
harness actually caught during development — two agents interpreting the
same spec differently:

| Pin | Divergence it killed |
| --- | --- |
| `urlFormat: "sqlalchemy-url"` | one agent read `database_url` as a bare path, another as a URL |
| `createDefaults` | one echoed sent values, another applied declared defaults |
| `alreadyExists` 409 body | unique-violation status/shape varied by shot |
| `listOrder` | unordered storage made list responses differ |
| `refFields` | refs as id strings vs nested objects |

When generation diverges, the fix is a new pin here plus suite assertions
— never a re-roll of the agent. The measured history lives in
`docs/golden-rule-results.md`.

## Implementation requirements carried by the blueprint

Implementations of a blueprint must additionally provide (pinned in the
agent prompt, enforced by verification):

- `app/main.py` exporting `create_app(database_url: str | None = None)`
  **and** a module-level `app = create_app()`
- a `pyproject.toml` with a `dev` extra providing `pytest` and `httpx`
- dependency resolution `create_app(database_url)` → `DATABASE_URL` env →
  SQLite fallback (`database.fallback`)
- no routes beyond the blueprint's route table (strict OpenAPI equality)
