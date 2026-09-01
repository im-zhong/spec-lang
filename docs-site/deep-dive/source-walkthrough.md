# Source-code walkthrough: one spec, end to end

This page traces **one specification** — `examples/booking/app.spec.ts` —
through **every stage of the system at the source level**: which function
in which file runs, with what input, producing what data. Every JSON
block, every log line and every piece of Python below is **real output
captured from actual runs** (`claude-sonnet-4-5`; generation is
DAG-structured, first-attempt-verified and repair-free — see below).

Reproduce everything static yourself:

```bash
pnpm spec check   examples/booking/app.spec.ts
pnpm spec build   examples/booking/app.spec.ts
pnpm spec generate examples/booking/app.spec.ts --dry-run
```

The dynamic steps (agent, verification) are `pnpm spec generate
examples/booking/app.spec.ts --shots 2`.

## The example

```ts
// examples/booking/app.spec.ts                       ← line numbers matter:
import { defineApp } from "@spec/core"                //  1
                                                      //
import { entity, field, crud, count,
         lifecycle, transition } from "@spec/web"//  3
import { auth, password } from "@spec/auth"           //  4
import { postgres } from "@spec/postgres"             //  5
import { fastapi } from "@spec/fastapi"               //  6
                                                      //
const User = entity("User", {                         //  9
  id: field.uuid(),                                   // 10
  email: field.email().unique(),                      // 11
  name: field.string(),                               // 12
})                                                    //
                                                      //
const Venue = entity("Venue", {                       // 15
  id: field.uuid(),                                   // 16
  name: field.string().unique(),                      // 17
  capacity: field.int(),                              // 18
})                                                    //
                                                      //
const Booking = entity("Booking", {                   // 21
  id: field.uuid(),                                   // 22
  user: field.ref("User"),                            // 23
  venue: field.ref("Venue"),                          // 24
  startsAt: field.datetime(),                         // 25
  notes: field.string().optional(),                   // 26
  status: field.enum("pending", "confirmed", "cancelled"), // 27
})                                                    //
                                                      //
const MainAuth = auth({                               // 29
  principal: User,                                    // 30
  strategy: password({ identity: User.fields.email }),// 31
})                                                    //
                                                      //
const Users    = crud(User,   { methods: ["list", "get"] })            // 34
const Venues   = crud(Venue,  { auth: false })                         // 35
const Bookings = crud(Booking, { methods: ["list", "get", "create", "delete"] }) // 36
const BookingCount = count(Booking)                                    // 37
                                                      //
const BookingFlow = lifecycle(Booking, {              // 39  the state machine:
  field: "status",                                    // 40  WHEN ops are legal
  initial: "pending",                                 // 41
  transitions: [                                      // 42
    transition("confirm", { from: ["pending"], to: "confirmed" }),      // 43
    transition("cancel", { from: ["pending", "confirmed"], to: "cancelled" }), // 44
  ],                                                  // 45
})                                                    // 46
                                                      //
const MainDB = postgres({ entities: [User, Venue, Booking] })          // 48
                                                      //
const Server = fastapi({                              // 41
  title: "Booking API",                               // 42
  stack: {                                            // 43  the tech stack is
    python: "3.13",                                   // 44  PART OF THE SPEC —
    dependencies: {                                   // 45  exact pins, no
      fastapi: "0.141.1",                             // 46  floating versions
      sqlalchemy: "2.0.52",                           // 47
      pydantic: "2.13.5",                             // 48
      pyjwt: "2.13.0",                                // 49
      bcrypt: "5.0.0",                                // 50
    },                                                // 51
    dev: { pytest: "9.1.1", httpx: "0.28.1" },        // 52
  },                                                  // 53
  services: [MainAuth, Users, Venues, Bookings, BookingCount],         // 54
  resources: [MainDB],                                // 55
})                                                    //
                                                      //
export default defineApp({                            // 58
  name: "BookingAPI",                                 // 48
  entities: [User, Venue, Booking],                   // 49
  services: [MainAuth, Users, Venues, Bookings, BookingCount],         // 50
  resources: [MainDB, Server],                        // 51
})                                                    // 52
```

Three entities, one auth service, three CRUD resources with different
method subsets and visibility, one count endpoint, one lifecycle (the
behavior model's Phase 1), one database, one server — seventeen routes in
the end, two of them state-machine transitions.

---

## Step 1 — Parse (`packages/compiler/src/parse.ts`)

Entry: `parsePass(compilation)` → `parseSpecFile(entryPath, displayPath)`.

```ts
const content = fs.readFileSync(file, "utf8")
const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
```

The file becomes a TypeScript `SourceFile` — **syntax tree only, never
executed**. Two things happen to it:

1. **Layer 1** — TS parse diagnostics become `SPEC_SYNTAX_ERROR`
   diagnostics. Ours: none.
2. **Layer 2** — `scanRestrictions()` walks every node rejecting loops,
   `await`, function/class/enum declarations, `let`, dynamic `import()`,
   `eval`/`Function`, `process.env`, `Date.now`, `Math.random`, and
   filesystem/network imports. Our file: nothing forbidden.

Then the import statements are collected into `ParsedSpec.imports`. For
our file the result is exactly:

```jsonc
[
  { "moduleSpecifier": "@spec/core",     "named": [{ "imported": "defineApp", "local": "defineApp" }] },
  { "moduleSpecifier": "@spec/web",      "named": [
      { "imported": "entity", "local": "entity" }, { "imported": "field", "local": "field" },
      { "imported": "crud", "local": "crud" },     { "imported": "count", "local": "count" } ] },
  { "moduleSpecifier": "@spec/auth",     "named": [
      { "imported": "auth", "local": "auth" },     { "imported": "password", "local": "password" } ] },
  { "moduleSpecifier": "@spec/postgres", "named": [{ "imported": "postgres", "local": "postgres" }] },
  { "moduleSpecifier": "@spec/fastapi",  "named": [{ "imported": "fastapi", "local": "fastapi" }] }
]
```

## Step 2 — Resolve (`packages/compiler/src/loader.ts`)

`resolvePass` builds a `PackageLoader` rooted at the spec file's directory
(`examples/booking/`) and loads each module specifier. For `@spec/web`:

```ts
const pkgJsonPath = nodeRequire.resolve(`@spec/web/package.json`)
// pnpm workspace link → packages/web/package.json
if (!pkgJson.spec?.package) return new Error("not a spec package")
const entry = require(path.resolve(pkgRoot, pkgJson.spec.entry)) // dist/spec-package.js
definition = entry.default   // definePackage({ name: "@spec/web", validators: [...] })
const exports = nodeRequire("@spec/web")  // { entity, field, crud, count, ... }
```

Each imported name becomes an `ImportedBinding` — local name → the actual
trusted function:

```ts
{ packageName: "@spec/web", imported: "crud", value: <the crud function> }
```

Loaded packages are deduplicated and sorted by name, so later artifact
order is stable:

```
@spec/auth  @spec/core  @spec/fastapi  @spec/postgres  @spec/web
```

This is the security boundary in action: **the only executable code from
here on is these five packages' builders and validators.** The user's
file remains data.

## Step 3 — Normalize (`packages/compiler/src/evaluate.ts` + `pipeline.ts`)

The heart of the static compiler. `evaluateSpec(parsed, imports)` walks
every top-level statement and **statically evaluates** it.

### Const `User` (line 9)

`entity("User", {...})` is a `CallExpression` with an identifier callee →
`evaluateCall` finds `entity` in the imports map → evaluates the
arguments: the string literal `"User"`, then the object literal — each
property value is itself a call, e.g. `field.email().unique()`:

1. `evaluateExpression` on `field.email()` → `evaluateCall` → receiver
   `field` (imported value) → member `email` exists → invoke → a
   `FieldSpec` (`{ __specFieldSpec: true, type: "email", ... }`)
2. `.unique()` → call on a property access of that FieldSpec → `makeField({...uniqueFlag: true})`

The `entity` builder (`packages/web/src/entity.ts`) receives the fully
evaluated object and returns a builder — plain data plus a `.fields` map
of `FieldRef`s for cross-references:

```ts
User.fields.email   //  { __specFieldRef: true, entity: "User", field: "email",
                    //    ownerNodeId: "entity:User", unique: true }
```

The evaluator then records `consts.set("User", builder)` and — because
the result `isNodeBuilder` — pushes it onto `nodes`. **Name adoption**:
the anonymous builder gets `name = "User"`… here the entity already has
its explicit name; for anonymous builders like `auth({...})` this is how
`MainAuth` becomes the node's name.

### Const `MainAuth` (line 29) → ref chain (line 31)

`User.fields.email` is a `PropertyAccessExpression`: evaluate `User`
(from consts) → read member `fields` → then `.email` → the `FieldRef`
above. The `password` builder serializes it into its attributes.
`toReference(User)` turns the principal builder into
`{ nodeId: "entity:User" }`.

### Const `Bookings` (line 36)

`crud(Booking, { methods: [...] })` — the second argument is evaluated to
a plain array/objects, then `crud()` (`packages/web/src/crud.ts`)
computes the default path via `pluralize` + `kebabCase` (`"Booking"` →
`"bookings"`) and stores the methods subset.

### Const `Server` (line 41)

`fastapi({...})` (`packages/fastapi/src/builder.ts`) — the services array
items are node builders, serialized via `toReference`:
`MainAuth → { nodeId: "auth:MainAuth" }`, `Users → { nodeId: "crud:User" }`,
… and because the served set contains crud **and** auth nodes, the
builder adds `requires: ["RelationalStore"]`.

### `export default defineApp(...)` (line 47)

Evaluated the same way; the result is the root builder. Statements that
are neither imports, consts nor `export default` would produce
`SPEC_UNSUPPORTED_SYNTAX` right here.

### Materialization (`normalizePass` → `materialize`)

Root builders are collected: the app node plus every const-bound node,
**deduplicated by identity** — `Booking` appears in `defineApp.entities`,
in `postgres.entities` and in `crud(Booking)` but is one object, so it
materializes once (`sharedRoots`). Deterministic ids are assigned:

| Const | Node id | Why |
| ----- | ------- | --- |
| `User` | `entity:User` | `nodeId("entity", name)` |
| `Booking` | `entity:Booking` | same scheme |
| `MainAuth` | `auth:MainAuth` | anonymous → adopts const name |
| `Bookings` | `crud:Booking` | crud adopts the **entity's** name |
| `password(...)` | `passwordStrategy:auth:MainAuth#0` | nested anonymous → parent + index |
| `MainDB` | `postgres:MainDB` | adopts const name |
| `Server` | `fastapi:Server` | adopts const name |

Sorted by id, the node list is:

```
api:BookingCount  app:BookingAPI  auth:MainAuth  crud:Booking  crud:User
crud:Venue  entity:Booking  entity:User  entity:Venue  fastapi:Server  postgres:MainDB
```

Here are three real nodes from the emitted IR — note the `source`
locations pointing at the file lines above, and how field specs were
flattened to plain data:

```jsonc
// entity:Booking — from line 21 (evaluateCall captured the source position)
{
  "id": "entity:Booking", "kind": "entity", "package": "@spec/web", "name": "Booking",
  "attributes": { "fields": {
      "id":       { "type": "uuid" },
      "notes":    { "optional": true, "type": "string" },
      "startsAt": { "type": "datetime" },
      "user":     { "target": "User",  "type": "ref" },
      "venue":    { "target": "Venue", "type": "ref" } } },
  "source": { "file": "examples/booking/app.spec.ts", "line": 21, "column": 17 }
}

// crud:Booking — from line 36; methods subset preserved, path derived
{
  "id": "crud:Booking", "kind": "crud", "package": "@spec/web", "name": "Booking",
  "attributes": {
    "auth": true,
    "entity": { "nodeId": "entity:Booking" },
    "methods": ["list", "get", "create", "delete"],
    "path": "/bookings" },
  "source": { "file": "examples/booking/app.spec.ts", "line": 36, "column": 18 }
}

// fastapi:Server — from line 41; refs + the derived capability requirement
{
  "id": "fastapi:Server", "kind": "fastapi", "package": "@spec/fastapi", "name": "Server",
  "attributes": {
    "port": 8000, "prefix": "", "title": "Booking API", "version": "0.1.0",
    "requires": ["RelationalStore"],
    "resources": [{ "nodeId": "postgres:MainDB" }],
    "services": [
      { "nodeId": "auth:MainAuth" }, { "nodeId": "crud:User" },
      { "nodeId": "crud:Venue" },    { "nodeId": "crud:Booking" },
      { "nodeId": "api:BookingCount" } ] },
  "source": { "file": "examples/booking/app.spec.ts", "line": 41, "column": 15 }
}
```

## Step 4 — Validate (`pipeline.ts` `validatePass`)

The flattened node list is handed to every validator registered by the
loaded packages, in package order. For our spec:

| Order | Validator (package) | What it did here |
| ----- | ------------------- | ---------------- |
| 1 | `web/validate-entities` | 3 entities, no duplicate names; every field has a known type; both `ref` targets (`User`, `Venue`) exist → no `FIELD_REF_TARGET_UNKNOWN` |
| 2 | `web/validate-crud` | every crud `entity` ref resolves; paths valid and unique; method subsets contain no unknowns or duplicates |
| 3 | `web/validate-count-apis` | `api:BookingCount` targets `entity:Booking` ✓ |
| 4 | `auth/validate-*` | principal `entity:User` exists; identity `User.email` belongs to the principal and is unique |
| 5 | `fastapi/validate-server` | all 5 `services` refs resolve to crud/api/auth nodes; the resource ref resolves; no generic `api()` without pinned operation; principal has no `ref` fields |

Validators only see the structural `ValidationContext`
(`findNodes`/`getNode`/`report`) — no domain knowledge leaks into the
compiler core. Result: **zero diagnostics**.

## Step 5 — Link (`pipeline.ts` `linkPass`)

Scans every node's `attributes.provides` / `attributes.requires` arrays:

- `postgres:MainDB` → `provides: ["RelationalStore"]`
- `auth:MainAuth`   → `requires: ["RelationalStore"]`
- `fastapi:Server`  → `requires: ["RelationalStore"]`

Two requirements, one provider each → no `MISSING_CAPABILITY_PROVIDER`,
no `DUPLICATE_CAPABILITY_PROVIDER`. The IR records (real output):

```json
"capabilities": {
  "required": [
    { "capability": "RelationalStore", "requester": "auth:MainAuth" },
    { "capability": "RelationalStore", "requester": "fastapi:Server" } ],
  "provided": [
    { "capability": "RelationalStore", "provider": "postgres:MainDB" } ]
}
```

Note what happened here: `@spec/fastapi` demanded storage, `@spec/postgres`
supplies it, and neither package knows the other exists. The compiler
core connected them.

## Step 6 — Emit (`compiler.ts` `emitPass` + `writeArtifacts`)

`lowerPass` is a no-op for the static IR (the agentic lowering happens in
`spec generate`). `emitPass` assembles the `SpecIR`
(`version: "spec-ir/0.1"`), and `writeArtifacts` serializes it through
`stableStringify` — keys sorted recursively, no timestamps — into
`.spec/spec.ir.json`, `manifest.json` (all five package versions) and
`diagnostics.json`. Same input ⇒ identical bytes, verified by the
100-compile SHA-256 test.

---

# The agentic half (`spec generate`)

Everything below runs only on a **valid** IR. Entry:
`packages/cli/src/index.ts` → `planGeneration(result.ir)`.

## Step 7 — Blueprint (`packages/fastapi/src/blueprint.ts`)

`buildBlueprint(ir)` flattens the IR once and derives the backend
contract. For our nodes:

- `app` node → `app: { name: "BookingAPI", title: "Booking API", prefix: "", port: 8000 }`
- `postgres:MainDB` → `database: { engine: "postgres", urlEnv: "DATABASE_URL", fallback: "sqlite:///./dev.db", urlFormat: "sqlalchemy-url" }`
- `fastapi:Server`'s `stack` overrides → merged with the target's pinned
  defaults → `stack` (below) — the technology stack is part of the
  specification, exactly versioned:
- `entity:*` → table names via `snakeCase` + plural (`Booking` → `bookings`), columns via `snakeCase` per field (`startsAt` → `starts_at`); `User` additionally gets `passwordColumn: "password_hash"` because it is the principal
- `crud:Venue` with `auth: false` and an **active** auth service → 5 public routes
- `crud:Booking` methods subset → 4 routes (no `PATCH`)
- `api:BookingCount` → `GET /bookings/count`
- `auth:MainAuth` + password strategy → login/register/me

The pinned stack, verbatim from `blueprint.json`:

```json
"stack": {
  "python": "3.13",
  "dependencies": {
    "bcrypt": "5.0.0", "email-validator": "2.2.0", "fastapi": "0.141.1",
    "pydantic": "2.13.5", "pydantic-settings": "2.15.0", "pyjwt": "2.13.0",
    "sqlalchemy": "2.0.52", "uvicorn": "0.52.4" },
  "dev": { "httpx": "0.28.1", "pytest": "9.1.1" }
}
```

One real route object, verbatim from `blueprint.json`:

```json
{
  "id": "GET /venues/{id}", "method": "GET", "path": "/venues/{id}",
  "operation": "get", "entity": "Venue", "status": 200, "auth": false,
  "response": { "kind": "entity", "entity": "Venue" }
}
```

And the auth block (truncated):

```jsonc
"auth": {
  "strategy": "password-jwt", "principal": "User",
  "identityField": "email", "passwordColumn": "password_hash",
  "routes": [
    { "id": "POST /auth/login", "method": "POST", "operation": "login",
      "status": 200, "auth": false,
      "request": { "shape": { "email": "string", "password": "string" } },
      "response": { "kind": "token" } },
    { "id": "POST /auth/register", "...": "201, body = email+name+password" },
    { "id": "GET /auth/me", "...": "200, auth: true" } ]
}
```

15 routes total. The `contract` section pins the observable behavior —
see the [blueprint reference](/reference/blueprint) for the full shape.

## Step 8 — Conformance suite (`packages/fastapi/src/conformance.ts`)

`buildConformanceSuite(blueprint)` emits four Python files. The
interesting generated logic is **reference seeding** in `helpers.py` —
for our Booking entity (real generated code):

```python
def body_for(client, entity, overrides=None, token=None):
    if entity == "Booking":
        _user = create_row(client, "User", token=token)     # User has NO create route…
        _venue = create_row(client, "Venue", token=token)   # …so seed via /auth/register
        base = {"user": _user["id"], "venue": _venue["id"], "startsAt": "2026-01-01T12:00:00"}
        if overrides:
            base.update(overrides)
        r = client.post("/bookings", json=base, headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 201, r.text
        return base, r.json()
    if entity == "User":                                    # ← the register fallback
        identity = f"{uuid.uuid4()}@example.com"
        body = {"email": identity, "name": "sample-name", "password": "secret123"}
        r = client.post("/auth/register", json=body)
        assert r.status_code == 201, r.text
        return body, r.json()
    if entity == "Venue":
        base = {"capacity": 42, "name": f"{uuid.uuid4()}-sample-name"}   # unique sample!
        ...
```

Why the `User` branch differs: `crud(User, { methods: ["list", "get"] })`
exposes no `POST /users`, so user rows can only be created through
`/auth/register` — the generator knows this and emits the fallback. And
`name` gets a uuid prefix because the spec declared it `unique` — a
constant sample would 409 on the second create.

`test_contract.py` opens with the interface oracle (real output):

```python
EXPECTED_INTERFACE = {
    "GET /bookings":         {"statuses": ["200"], "pathParams": []},
    "GET /bookings/{id}":    {"statuses": ["200"], "pathParams": ["id"]},
    "POST /bookings":        {"statuses": ["201"], "pathParams": []},
    "DELETE /bookings/{id}": {"statuses": ["204"], "pathParams": ["id"]},
    "GET /users":            {"statuses": ["200"], "pathParams": []},
    "GET /users/{id}":       {"statuses": ["200"], "pathParams": ["id"]},
    "GET /venues":           {"statuses": ["200"], "pathParams": []},
    "GET /venues/{id}":      {"statuses": ["200"], "pathParams": ["id"]},
    "POST /venues":          {"statuses": ["201"], "pathParams": []},
    "PATCH /venues/{id}":    {"statuses": ["200"], "pathParams": ["id"]},
    "DELETE /venues/{id}":   {"statuses": ["204"], "pathParams": ["id"]},
    "GET /bookings/count":   {"statuses": ["200"], "pathParams": []},
    "POST /auth/login":      {"statuses": ["200"], "pathParams": []},
    "POST /auth/register":   {"statuses": ["201"], "pathParams": []},
    "GET /auth/me":          {"statuses": ["200"], "pathParams": []},
}
```

…asserted with **strict set equality** against the app's own
`/openapi.json`. And a generated count test:

```python
def test_count_booking(client):
    token = auth_token(client)
    r = client.get("/bookings/count", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    assert r.json() == {"count": 0}
    create_row(client, "Booking", token=token)
    r = client.get("/bookings/count", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    assert r.json() == {"count": 1}
```

## Step 9 — The generation DAG (`packages/fastapi/src/dag.ts`)

Code has structure, so generation has structure. `buildTaskDag(blueprint,
ir)` lowers the contract into a task graph — for booking, ten tasks:

```
project ──► models ──► schemas ──► router:Booking ─┐
   │           │  ╲                 router:User  ──┤
   │           │   ╲► security ───► router:auth ───┤
   └──► database ──────────────────► router:Venue ─┤  (public: no security dep)
                                                   ▼
                                                  app
```

Each task owns a narrow file scope and a **per-task prompt** — a pure
function of its blueprint slice. The real prompt for the `project` task
opens:

```text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: project skeleton

- Your scope (create/modify ONLY these): pyproject.toml, app/__init__.py, .gitignore
- Already generated by previous tasks (read-only for you): —

…requires-python = "==3.13.*", with EXACTLY these pinned dependencies
(the stack is part of the specification — do not add, remove or float
any version):
    "fastapi==0.141.1", "sqlalchemy==2.0.52", "pydantic==2.13.5", …
```

and the `router:Venue` prompt carries only Venue's entity JSON, its five
public routes, and the shared invariants — not the whole blueprint. The
DAG and every prompt are fingerprinted (`dagFingerprint`) into
`agent.tasks.json`; identical specs produce identical DAGs byte-for-byte.

## Step 10 — The agent harness (`packages/agent/src/harness.ts`)

`AgentHarness.execute()` walks the topological order (Kahn, stable by
id) and runs **one headless agent per task**:

```
claude -p --output-format json --permission-mode acceptEdits   --max-turns 60 --model claude-sonnet-4-5   --allowedTools Read Glob Grep LS Edit Write Bash(uv:*) Bash(python:*) …
```

The workspace is hashed before and after each task, so the harness can
attribute every file to the task that produced it and flag anything
touched outside the declared scope. A real per-task table (from the
inventory pilot, `agent.result.json`):

| Task | Turns | Cost | Produced |
| ---- | ----- | ---- | -------- |
| `project` | 6 | $0.24 | `pyproject.toml`, `app/__init__.py`, `.gitignore` |
| `database` | 37 | $0.84 | `app/config.py`, `app/database.py` |
| `models` | 22 | $0.66 | `app/models.py`, `uv.lock` ⚠ |
| `schemas` | 14 | $0.52 | `app/schemas.py` |
| `router:Category` | 27 | $0.80 | `app/routers/category.py` |
| `router:Product` | 14 | $0.30 | `app/routers/product.py` |
| `app` | 15 | $0.30 | `app/main.py`, `dev.db` ⚠ |

(⚠ = scope-violation warnings: the models task ran `uv lock`, the app
task imported the app and created the SQLite fallback — benign
side-effects, recorded but not fatal; conformance is the judge.)

The generated code itself keeps the same shape as before — the factory
every later step depends on:

```python
def create_app(database_url: str | None = None) -> FastAPI:
    url = database_url or os.environ.get("DATABASE_URL") or "sqlite:///./dev.db"
    ...
    Base.metadata.create_all(engine)
    return application

app = create_app()
```

## Step 11 — Verification, ONCE (`packages/fastapi/src/verify.ts` + `orchestrate.ts`)

The compiler drops the conformance suite into the workspace and runs:

```bash
uv venv .venv --clear --quiet --python 3.13
uv pip install --quiet -e '.[dev]'        # resolves the pinned stack exactly
.venv/bin/python -c "from app.main import app, create_app; assert app.title"
.venv/bin/python -m pytest conformance -q
```

**There is no second attempt.** If any command fails, the shot reports
`GENERATION_NONCONFORMANT` — by policy a specification/blueprint defect:
pin the contract, regenerate all shots.

## Step 12 — Why there is no repair story

An earlier architecture had a bounded repair loop, and a divergence it
"fixed" is worth remembering. Two shots had read an unpinned behavior —
does `GET /users` include the requesting principal? — differently:

- shot 1 listed *every principal except the requester*;
- shot 2 listed *everyone* — the suite expected the first reading and
  failed it;
- the repair loop patched shot 2 until it matched.

That outcome is exactly what the golden rule forbids: the shots agreed
only because a patcher forced them to. The **fix belonged in the
contract**, and is now there:

```jsonc
// blueprint.contract.serialization
"listScope": "allRows"   // list returns EVERY row — including the
                         // requesting principal. No requester filtering.
```

with matching suite assertions: the principal list test fetches its own
row via `/auth/me` and expects it **first** in the list:

```python
def test_user_list(client):
    token = auth_token(client)
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    first = create_row(client, "User")
    second = create_row(client, "User")
    r = client.get("/users", headers={"Authorization": f"Bearer {token}"})
    assert [row["id"] for row in r.json()] == [me.json()["id"], first["id"], second["id"]]
```

The repair loop is gone from the codebase. Same discipline for the stack:
version drift across install dates used to be luck; the stack is now
pinned **in the specification** (`fastapi({ stack: {...} })`, merged onto
`@spec/fastapi`'s validated defaults), so every shot of every future
generation resolves identical dependencies.

## Step 13 — Repeatability (`packages/agent/src/repeatability.ts`)

With all shots conformant, each workspace runs the OpenAPI snapshot:

```python
from app.main import app
spec = app.openapi()
norm = {f"{method.upper()} {path}": {
    "statuses": sorted(op.get("responses", {}).keys()),
    "pathParams": sorted(p["name"] for p in op.get("parameters", []) if p.get("in") == "path"),
    "requestBody": bool(op.get("requestBody", {}).get("required", False)),
} ...}
print(json.dumps(norm, sort_keys=True, indent=2))
```

Every snapshot must be byte-identical → `INTERFACE_IDENTICAL`. The
verdict line the CLI prints:

```
✓ Generation repeatable across 3 shot(s), zero repairs
```

## Step 14 — Artifacts & provenance (`packages/agent/src/artifacts.ts`)

Every workspace file becomes a hashed `Artifact`; the harness's per-task
diffs additionally record **which task produced which file**:

```jsonc
{ "id": "artifact:app/main.py", "type": "source", "path": "app/main.py",
  "contentHash": "…", "generatedBy": "fastapi:dag",
  "sourceNodes": ["api:BookingCount", "app:BookingAPI", "auth:MainAuth",
                  "crud:Booking", "crud:User", "crud:Venue", "entity:Booking",
                  "entity:User", "entity:Venue", "fastapi:Server", "postgres:MainDB"] }
```

The provenance chain is fully navigable:
`Artifact → DagTask → SpecNode → SourceLocation (file, line, column)`.

## Source map

Where everything in this walkthrough lives:

| Stage | File |
| ----- | ---- |
| Parse | `packages/compiler/src/parse.ts` |
| Resolve / load | `packages/compiler/src/loader.ts` |
| Static evaluation | `packages/compiler/src/evaluate.ts` |
| Normalize / validate / link / emit | `packages/compiler/src/pipeline.ts` |
| Orchestration + artifacts writing | `packages/compiler/src/compiler.ts` |
| `entity` / `field` | `packages/web/src/entity.ts`, `field.ts` |
| `crud` / `count` | `packages/web/src/crud.ts` |
| web validators | `packages/web/src/validators.ts` |
| `auth` / `password` | `packages/auth/src/builders.ts` |
| `postgres` | `packages/postgres/src/index.ts` |
| `fastapi()` builder | `packages/fastapi/src/builder.ts` |
| Blueprint (+ stack pins) | `packages/fastapi/src/blueprint.ts` |
| Generation DAG | `packages/fastapi/src/dag.ts` |
| Conformance generator | `packages/fastapi/src/conformance.ts` |
| Per-task prompts | `packages/fastapi/src/prompt.ts` |
| Verification plan | `packages/fastapi/src/verify.ts` |
| Plan assembly | `packages/fastapi/src/lowering.ts` |
| Claude Code runner | `packages/agent/src/runner.ts` |
| Agent harness (DAG executor) | `packages/agent/src/harness.ts` |
| Shot lifecycle (no repair) | `packages/agent/src/orchestrate.ts` |
| Repeatability | `packages/agent/src/repeatability.ts` |
| Artifact scan | `packages/agent/src/artifacts.ts` |
| `spec generate` | `packages/cli/src/index.ts` |
