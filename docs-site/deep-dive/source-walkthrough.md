<script setup>
import TaskPrompts from "../.vitepress/theme/components/TaskPrompts.vue"
</script>

# Source-code walkthrough: Booking, end to end

This page preserves a trace of `examples/booking/app.spec.ts` through the
**legacy local repeatability harness** used for the 2026-09-01 measured run.
It is historical evidence, not the current execution workflow. Current real
generation uses one temporary GitHub repository per shot, durable task
branches/PRs/checks, and immutable integration bases; see [Git and GitHub
execution](/reference/github-execution).

The historical reference run used Claude Code with `deepseek-v4-flash[1m]` selected by
Claude Code's own configuration. Two Booking shots ran in parallel. Each shot
executed ten sequential DAG tasks and received one final conformance attempt,
with no repair.

```bash
pnpm spec check examples/booking/app.spec.ts
pnpm spec generate examples/booking/app.spec.ts --dry-run
# Historical command; current execution also requires run/image/agent pins.
pnpm spec generate examples/booking/app.spec.ts --shots 2
```

The last command normally accepts `--model <id>`. When the runner is launched
without a model override, Claude Code resolves the model from its settings.

## System map

```text
app.spec.ts
    |
    | Parse -> Resolve -> Normalize -> Validate -> Link -> Lower(no-op) -> Emit
    v
Spec IR
    |
    | buildBlueprint() -> buildTaskDag() -> buildConformanceSuite()
    v
FastApiGenerationPlan
    |
    | runRepeatability()
    +------ shot-1: 10 agent tasks -> verify once ----+
    +------ shot-2: 10 agent tasks -> verify once ----+  parallel
                                                        |
                                                        v
                                    functional conformance + OpenAPI equality
```

The static half is deterministic and executes no user specification code. The
agentic half is nondeterministic in implementation, but every result is judged
against compiler-owned behavior.

## The current Booking specification

The example exercises all three implemented behavior facets:

- point behavior: CRUD, count, auth, request/response and error contracts;
- line behavior: a lifecycle with state transitions and a runtime guard;
- plane behavior: a cross-row no-overbooking invariant;
- causal effects: a field assignment and an outbox event.

```ts
import { defineApp } from "@spec/core"
import {
  entity, field, crud, count,
  lifecycle, transition, invariant, expr, effect,
} from "@spec/web"
import { auth, password } from "@spec/auth"
import { postgres } from "@spec/postgres"
import { fastapi } from "@spec/fastapi"

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
  cancelledAt: field.datetime().optional(),
})

const MainAuth = auth({
  principal: User,
  strategy: password({ identity: User.fields.email }),
})

const Users = crud(User, { methods: ["list", "get"] })
const Venues = crud(Venue, { auth: false })
const Bookings = crud(Booking, {
  methods: ["list", "get", "create", "delete"],
})
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
        effect.emit("booking.confirmed", ["id", "venue", "startsAt"]),
      ],
    }),
    transition("cancel", {
      from: ["pending", "confirmed"],
      to: "cancelled",
      effects: [effect.set("cancelledAt", expr.request.time())],
    }),
  ],
})

const NoOverbooking = invariant("no-overbooking", {
  on: Venue,
  check: expr.countOf(Booking, { venue: "self" })
    .lte(expr.field("capacity")),
})

const MainDB = postgres({ entities: [User, Venue, Booking] })

const Server = fastapi({
  title: "Booking API",
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
  services: [
    MainAuth, Users, Venues, Bookings, BookingCount,
    BookingFlow, NoOverbooking,
  ],
  resources: [MainDB],
})

export default defineApp({
  name: "BookingAPI",
  entities: [User, Venue, Booking],
  services: [
    MainAuth, Users, Venues, Bookings, BookingCount,
    BookingFlow, NoOverbooking,
  ],
  resources: [MainDB, Server],
})
```

This lowers to 3 entities, 17 routes, 1 lifecycle, 1 invariant, an outbox
table, auth, a relational store and a fully pinned Python stack.

## Step 1: parse the TypeScript AST

Entry: `packages/compiler/src/pipeline.ts` -> `parsePass()` ->
`packages/compiler/src/parse.ts` -> `parseSpecFile()`.

```ts
const sourceFile = ts.createSourceFile(
  file,
  content,
  ts.ScriptTarget.ES2022,
  true,
  ts.ScriptKind.TS,
)
```

The source becomes a TypeScript `SourceFile`; it is never transpiled or
executed. The parser reports TypeScript syntax errors and scans the tree for
the restricted language rules. Loops, `let`, `await`, functions, classes,
dynamic imports, filesystem/network imports, `eval`, `process.env`,
`Date.now()` and `Math.random()` are rejected before evaluation.

The parser also extracts named imports. For example:

```json
{
  "moduleSpecifier": "@spec/web",
  "named": [
    { "imported": "entity", "local": "entity" },
    { "imported": "lifecycle", "local": "lifecycle" },
    { "imported": "invariant", "local": "invariant" },
    { "imported": "expr", "local": "expr" },
    { "imported": "effect", "local": "effect" }
  ]
}
```

## Step 2: resolve trusted packages

Entry: `resolvePass()` -> `packages/compiler/src/loader.ts`.

`PackageLoader` resolves every imported module from the spec file's directory,
reads its `package.json`, requires `spec.package: true`, then loads two trusted
surfaces:

```ts
const definition = require(specEntry).default // validators, kinds, inspectors
const exports = nodeRequire(moduleSpecifier)  // DSL builder functions
```

For Booking, the sorted package set is:

```text
@spec/auth  @spec/core  @spec/fastapi  @spec/postgres  @spec/web
```

This is the execution boundary. Package builders and validators execute;
`app.spec.ts` remains AST data.

## Step 3: statically evaluate expressions

Entry: `normalizePass()` -> `packages/compiler/src/evaluate.ts` ->
`evaluateSpec()`.

The evaluator supports only literals, arrays, object literals, identifiers,
property access and calls on trusted imported values or on values produced by
those calls.

For `field.email().unique()`:

```text
field.email()       -> trusted method call -> FieldSpec(type=email)
.unique()           -> trusted method call -> immutable FieldSpec(unique=true)
entity("User", ...) -> trusted builder     -> SpecNodeBuilder
```

For `User.fields.email`, property access resolves a `FieldRef`:

```ts
{
  __specFieldRef: true,
  entity: "User",
  field: "email",
  ownerNodeId: "entity:User",
  unique: true,
}
```

For the guard and effects, the evaluator builds pure expression trees. It does
not evaluate the clock:

```json
{
  "__expr": "cmp",
  "left": { "__expr": "field", "name": "startsAt" },
  "op": "gt",
  "right": { "__expr": "requestTime" }
}
```

`requestTime` means "evaluate once when the request starts"; it is distinct
from forbidden compile-time nondeterminism such as `Date.now()`.

Anonymous builders adopt their `const` names. Consequently `auth({...})`,
`postgres({...})` and `fastapi({...})` become `MainAuth`, `MainDB` and
`Server` without executing user assignments.

## Step 4: materialize deterministic IR nodes

Entry: `normalizePass()` -> `materialize()` in
`packages/compiler/src/pipeline.ts`.

Root builders are deduplicated by identity, recursively serialized, assigned
stable ids and sorted. Important Booking ids include:

| Source binding | IR id |
| --- | --- |
| `Booking` | `entity:Booking` |
| `Bookings` | `crud:Booking` |
| `BookingCount` | `api:BookingCount` |
| `BookingFlow` | `lifecycle:Booking` |
| `NoOverbooking` | `invariant:no-overbooking` |
| `MainAuth` | `auth:MainAuth` |
| nested `password(...)` | `passwordStrategy:auth:MainAuth#0` |
| `MainDB` | `postgres:MainDB` |
| `Server` | `fastapi:Server` |

Field specs flatten to JSON data; builder references become `{ nodeId }`;
functions and internal markers do not enter the IR. Every node carries its
project-relative source location.

The lifecycle and invariant remain data, not prompt prose:

```json
{
  "id": "lifecycle:Booking",
  "kind": "lifecycle",
  "attributes": {
    "entity": { "nodeId": "entity:Booking" },
    "field": "status",
    "initial": "pending",
    "transitions": [
      {
        "event": "confirm",
        "from": ["pending"],
        "to": "confirmed",
        "guard": { "__expr": "cmp", "...": "request-time comparison" },
        "effects": [
          {
            "__effect": "emit",
            "event": "booking.confirmed",
            "fields": ["id", "venue", "startsAt"]
          }
        ]
      }
    ]
  }
}
```

## Step 5: validate domain semantics

Entry: `validatePass()` plus validators registered by each `SpecPackage`.

The compiler supplies only `findNodes`, `getNode` and `report`; all domain
knowledge stays in packages. Booking exercises these checks:

| Package | Checks used by this spec |
| --- | --- |
| `@spec/web` | entity names, field types, ref targets, CRUD methods/paths, count target |
| `@spec/web` lifecycle | enum field, initial state, transition targets, duplicate edges, reachability |
| `@spec/web` expressions | guard field/type, SQL-lowerable shape, request-time use |
| `@spec/web` effects | set target/type, event name, payload fields, immutable fields |
| `@spec/web` invariant | target resolution, count-ref edge, bound field/type, supported shape |
| `@spec/auth` | principal, strategy, identity membership and uniqueness |
| `@spec/fastapi` | served service/resource references and supported target surface |

The closed behavior vocabulary is deliberate. A guard or invariant is accepted
only when the target can lower it mechanically; otherwise the compiler emits a
diagnostic instead of asking the agent to interpret prose.

## Step 6: link capabilities and emit

`linkPass()` scans generic `attributes.provides` and `attributes.requires`:

```text
postgres:MainDB  provides RelationalStore
auth:MainAuth    requires RelationalStore
fastapi:Server   requires RelationalStore
```

No package-specific branch exists in the compiler. The resulting capability
edges are sorted into the IR.

The static `lowerPass()` is currently a no-op. `emitPass()` writes
`spec-ir/0.2`; target-specific lowering starts later from `spec generate`.
`stableStringify()` recursively sorts keys, and generated timestamps are
omitted, so repeated static builds are byte-identical.

## Step 7: build the backend blueprint

Entry: `packages/cli/src/index.ts` -> `planGeneration(ir)` ->
`packages/fastapi/src/lowering.ts` -> `buildBlueprint(ir)`.

The blueprint is the boundary between deterministic compilation and agentic
implementation. For Booking it contains:

```text
3 entities
17 routes
1 password-JWT auth contract
1 lifecycle with 2 transitions
1 cross-row invariant
1 events outbox table
1 exact dependency stack
```

The confirm route shows how behavior is carried as structured data:

```json
{
  "id": "POST /bookings/{id}/confirm",
  "method": "POST",
  "path": "/bookings/{id}/confirm",
  "operation": "transition",
  "entity": "Booking",
  "status": 200,
  "auth": true,
  "response": { "kind": "entity", "entity": "Booking" },
  "transition": {
    "field": "status",
    "event": "confirm",
    "from": ["pending"],
    "to": "confirmed",
    "guard": {
      "__expr": "cmp",
      "left": { "__expr": "field", "name": "startsAt" },
      "op": "gt",
      "right": { "__expr": "requestTime" }
    },
    "effects": [
      {
        "__effect": "emit",
        "event": "booking.confirmed",
        "fields": ["id", "venue", "startsAt"]
      }
    ]
  }
}
```

The invariant is separately normalized and attached by id to the operations
that must preserve it:

```json
{
  "id": "invariant:no-overbooking",
  "entity": "Venue",
  "shape": "crossRowCount",
  "count": {
    "entity": "Booking",
    "refField": "venue",
    "op": "lte",
    "bound": { "kind": "field", "name": "capacity" }
  }
}
```

`POST /bookings` and `PATCH /venues/{id}` carry
`invariantIds: ["invariant:no-overbooking"]`. The blueprint also pins exact
errors (`401`, `404`, `409`, `422`), list scope/order, defaults, UUID creation,
reference serialization and the SQLAlchemy URL format.

The emitted outbox shape is equally explicit:

```json
{
  "eventsTable": "events",
  "columns": {
    "id": "uuid",
    "event": "text",
    "payload": "json",
    "created_at": "datetime"
  }
}
```

## Step 8: generate the functional oracle

Entry: `packages/fastapi/src/conformance.ts` ->
`buildConformanceSuite(blueprint)`.

The compiler emits four files:

| File | Purpose |
| --- | --- |
| `conformance/conftest.py` | fresh `create_app()` plus isolated SQLite database per test |
| `conformance/helpers.py` | valid bodies, recursive ref seeding, registration/login helpers |
| `conformance/test_contract.py` | HTTP behavior assertions derived from the blueprint |
| `conformance/contract.json` | the exact blueprint used as the oracle |

This is runtime functional testing, not a static schema check. `TestClient`
starts the generated application and sends real requests against a fresh
database. The Booking suite contains 24 tests covering:

- strict route/interface shape;
- register, login, `/auth/me`, invalid credentials and missing tokens;
- protected and public routes;
- Booking create/list/get/delete and request validation;
- User list/get and Venue full CRUD;
- count before and after a create;
- confirm/cancel legal and illegal state transitions;
- the `startsAt > request.time` guard;
- `cancelledAt` assignment and the exact outbox event payload;
- no-overbooking rejection, rollback and boundary behavior.

For example, each test gets a fresh database:

```python
@pytest.fixture()
def client(tmp_path):
    db_path = str(tmp_path / "test.db")
    application = create_app(database_url=f"sqlite:///{db_path}")
    with TestClient(application) as test_client:
        test_client.db_path = db_path
        yield test_client
```

The suite is generated once from the blueprint and copied byte-for-byte into
every shot. The agent cannot edit the final oracle: orchestration writes it
after generation.

## Step 9: lower code structure to a DAG

Entry: `packages/fastapi/src/dag.ts` -> `buildTaskDag()`.

Booking produces ten tasks in stable topological order:

```text
project
  +-> database ------------------------------+
  +-> models -> schemas ---------------------+
            +-> security --------------------+

models + schemas + database + security -> router:Booking
models + schemas + database + security -> router:User
models + schemas + database            -> router:Venue
models + schemas + database + security -> router:auth

all routers + database -> app
```

`buildTaskDag(blueprint, ir)` does not ask the model to invent this graph.
It applies fixed structural rules:

1. Always create `project`, `models`, `database` and `schemas` tasks.
2. Add `security` and `router:auth` only when the blueprint contains auth.
3. Collect every entity named by a blueprint route, sort the names, and add
   one router task per entity. CRUD, count and transition routes for the same
   entity are merged into that router.
4. Give every entity router `models`, `schemas` and `database` dependencies.
   Add `security` when any of its routes is protected, or when the entity is
   the auth principal.
5. Make `app` depend on every router plus `database` so wiring is the sink.
6. Run stable Kahn topological sorting: all currently ready task ids are
   sorted lexicographically before being appended.

The result is deterministic because the inputs are deterministic Blueprint/IR
data and every conditional above is pinned compiler code. The DAG fingerprint
includes ids, edges, scopes, provenance ids and the full prompt bytes.

The public Venue router deliberately has no security dependency. Every task
owns an explicit file scope and names the dependency files it should read:

| Task | Depends on | Writable scope | Named read-only context |
| --- | --- | --- | --- |
| `project` | - | `pyproject.toml`, `app/__init__.py`, `.gitignore` | - |
| `database` | `project` | `app/config.py`, `app/database.py` | `app/__init__.py` |
| `models` | `project` | `app/models.py` | `app/__init__.py` |
| `schemas` | `models` | `app/schemas.py` | `app/models.py` |
| `security` | `models`, `database` | `app/security.py`, `app/deps.py` | models, database |
| `router:Booking` | models, schemas, database, security | `app/routers/booking.py` | all four dependency outputs |
| `router:User` | models, schemas, database, security | `app/routers/user.py` | all four dependency outputs |
| `router:Venue` | models, schemas, database | `app/routers/venue.py` | all three dependency outputs |
| `router:auth` | models, schemas, database, security | `app/routers/auth.py` | models, schemas, security |
| `app` | all routers, database | `app/main.py` | every router plus database/config |

Prompts and dependency edges are deterministic. `agent.tasks.json` stores
each prompt's SHA-256 instead of duplicating the prompt text.

## Step 10: construct narrow prompts

Entry: `packages/fastapi/src/prompt.ts`.

Each prompt is a pure function of the relevant blueprint slice. It contains:

- the single task name and owned file list;
- dependency files that may be read but not modified;
- global pinned invariants;
- only the entities, routes, transitions and invariants needed by that task;
- explicit request, response, error and transaction behavior.

The Booking router prompt receives the lifecycle and invariant data. The Venue
router receives the invariant but no auth implementation requirements. The app
task receives wiring information, not permission to redesign routes.

The agent is choosing Python implementation details. It is not choosing API or
behavior semantics.

### Are task contexts independent?

There are two different kinds of context:

```text
task N Claude process                  task N+1 Claude process
fresh conversation                     fresh conversation
prompt N                               prompt N+1
      |                                      |
      +---------- same workspace ------------+
                   files persist
```

- **Conversation context is independent.** Every DAG node calls
  `claude -p` as a new process. The runner does not pass `--resume`, a session
  id, the previous response or previous conversation tokens.
- **Artifact context is integrated.** All tasks in one shot use the same
  workspace. A task sees files written by earlier tasks and its prompt tells it
  which dependency files to read and treat as read-only.
- **Writes are narrow and audited.** The task may modify only its `scope`.
  Workspace hashes before and after the run identify produced files and report
  out-of-scope writes.
- **Execution is sequential within a shot.** Even DAG nodes that are mutually
  independent currently run one at a time in stable topological order. Separate
  shots have separate workspaces and run in parallel.

The important nuance is that an edge is both a scheduling dependency and an
artifact dependency, not a shared model chat. For example, `schemas` starts a
fresh Claude session but reads `app/models.py`; `app` starts another fresh
session and reads all completed routers. Also, the explicit read-only context
list can be narrower than `dependsOn`: `router:auth` depends on `database` for
ordering, while its prompt names models, schemas and security as its primary
read context.

### All Booking task prompts

These are the complete prompt bytes produced from the current Booking
Blueprint, not abbreviated examples. They are stored without a timestamp, and
each displayed SHA-256 matches the corresponding value in
`examples/booking/.spec/agent.tasks.json`. Expand one task at a time, or use the
controls to open or close the full set.

<TaskPrompts />

## Step 11: run Claude Code and audit every task

Entry: `packages/agent/src/runner.ts` and
`packages/agent/src/harness.ts`.

The runner launches Claude Code headlessly:

```text
claude -p --output-format json
       --max-turns 60
       --allowedTools Read Glob Grep LS Edit Write Bash(uv:*) Bash(python:*) ...
```

`--model` is appended only when the runner receives a non-empty model override.
In the measured run it was omitted, and Claude Code resolved
`deepseek-v4-flash[1m]` from its settings. Each workspace log contained ten
model-resolution entries, exactly one for each DAG task.

Within a shot, tasks are sequential because they share a workspace. Before and
after every task, the harness hashes visible artifacts and records:

- files created or modified;
- content SHA-256 values;
- scope violations;
- session id, turns, duration and cost.

Independent shots use separate workspaces and run concurrently through
`Promise.all`. An agent-run infrastructure failure may repeat the identical
prompt once. That retry is transport tolerance, not repair. In the measured
Booking run every log had ten entries for ten tasks, so no task retry occurred.

The measured scope warnings were non-source side effects:

- `.agent-stderr.log`, appended by the runner itself;
- one `uv.lock`, created while an agent inspected the environment;
- one `dev.db`, created when a task imported the module-level app.

They were recorded but did not alter the compiler-owned oracle. Conformance,
not the agent's own testing, determines the verdict.

## Step 12: verify each shot once

Entry: `packages/fastapi/src/verify.ts` and
`packages/agent/src/orchestrate.ts`.

After all ten tasks succeed, orchestration writes the compiler-owned suite and
runs this plan exactly once:

```bash
uv venv .venv --clear --quiet --python 3.13
uv pip install --quiet -e '.[dev]'
.venv/bin/python -c "from app.main import app, create_app; assert app.title"
.venv/bin/python -m pytest conformance -q
```

There is no conformance repair and no second verification attempt. A failure
produces `GENERATION_NONCONFORMANT`; the correct response is to pin missing
behavior in the spec, IR, blueprint or suite, then regenerate every shot.

## Step 13: compare independent results

Entry: `packages/agent/src/repeatability.ts` -> `runRepeatability()`.

The current repeatability verdict has two gates:

```text
all shots pass the same functional conformance suite on first verification
AND
all normalized OpenAPI snapshots are byte-identical
```

The OpenAPI snapshot retains route, method, success statuses, path parameters
and required request-body presence. It intentionally drops descriptions,
operation ids and other non-contract metadata.

This distinction matters:

- functionality is tested independently in every shot against exact expected
  responses and state changes;
- interface shape is then compared directly across shots;
- the current harness does not yet run a shared request trace against both
  live apps and compare every response/database/event trace directly.

Passing the same deterministic oracle is strong evidence of behavior equality
over the covered contract, but it is not exhaustive differential testing.

## Step 14: measured 2 x 2 result

The 2026-09-01 run generated cblog and Booking independently, two parallel
shots per project, using Claude Code configured for
`deepseek-v4-flash[1m]`.

| Project | Routes | Shot 1 | Shot 2 | OpenAPI | Repair |
| --- | ---: | --- | --- | --- | --- |
| cblog | 19 | 28 passed, $10.63 | 28 passed, $11.44 | identical | none |
| Booking | 17 | 24 passed, $12.25 | 24 passed, $11.66 | identical | none |

For Booking, every setup and check command exited zero:

```text
shot-1: venv ok -> install ok -> import ok -> 24 passed in 12.21s
shot-2: venv ok -> install ok -> import ok -> 24 passed in 12.73s
report: REPEATABLE + INTERFACE_IDENTICAL
```

No spec, IR or blueprint change was needed during this valid run. Earlier DNS
failures occurred before code generation and were infrastructure failures, not
behavior verdicts.

## Step 15: artifact provenance

Entry: `packages/agent/src/artifacts.ts`.

After verification, generated files become `Artifact` records:

```ts
interface Artifact {
  id: string
  type: "source" | "config" | "test" | "document" | "verification"
  path?: string
  contentHash?: string
  generatedBy?: string
  sourceNodes?: string[]
}
```

The report connects:

```text
Artifact -> DAG task -> SpecNode id -> SourceLocation
```

`agent.result.json` also stores per-task produced files, scope warnings, costs,
verification command outputs and the project-level repeatability diagnostics.
Session ids and timings are intentionally outside deterministic IR artifacts.

## Source map

| Stage | Source |
| --- | --- |
| Parse and restrictions | `packages/compiler/src/parse.ts` |
| Package resolution | `packages/compiler/src/loader.ts` |
| Static evaluator | `packages/compiler/src/evaluate.ts` |
| Normalize, validate, link, emit | `packages/compiler/src/pipeline.ts` |
| Core types and serialization | `packages/core/src/types.ts`, `builder.ts` |
| Entity, CRUD and behavior DSL | `packages/web/src/*.ts` |
| Web behavior validators | `packages/web/src/validators.ts` |
| Auth and storage builders | `packages/auth/src/*`, `packages/postgres/src/*` |
| FastAPI target builder | `packages/fastapi/src/builder.ts` |
| Blueprint lowering | `packages/fastapi/src/blueprint.ts` |
| Functional conformance generator | `packages/fastapi/src/conformance.ts` |
| Generation DAG and prompts | `packages/fastapi/src/dag.ts`, `prompt.ts` |
| Plan assembly and verification | `packages/fastapi/src/lowering.ts`, `verify.ts` |
| Claude Code runner | `packages/agent/src/runner.ts` |
| DAG harness | `packages/agent/src/harness.ts` |
| One-shot orchestration | `packages/agent/src/orchestrate.ts` |
| Parallel repeatability | `packages/agent/src/repeatability.ts` |
| Artifact provenance | `packages/agent/src/artifacts.ts` |
| CLI integration | `packages/cli/src/index.ts` |

Next: read the [blueprint reference](/reference/blueprint) for the complete
contract shape, or [generation internals](/reference/generation) for the exact
runner and report types.
