# Agentic generation

`spec generate` is where the two halves of the compiler meet: the
**traditional** half (deterministic passes, IR, blueprint, conformance
suite) and the **agentic** half (a coding agent that writes the actual
application).

This page is the hands-on tutorial; the machine internals live in the
[generation reference](/reference/generation), and the contract data in
the [blueprint reference](/reference/blueprint).

## Prerequisites

- the `claude` CLI on `PATH` (driven headlessly, tool-restricted)
- `uv` and Python 3.10+ (verification of generated apps)
- expect roughly $1–4 and 10–30 minutes per generated shot

## 1. Write the backend specification

Everything a RESTful backend needs is vocabulary — entities, CRUD
resources, auth, storage, and the server that serves it all. From
`examples/booking/app.spec.ts`:

```ts
import { defineApp } from "@spec/core"
import { entity, field, crud, count } from "@spec/web"
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
})

const MainAuth = auth({
  principal: User,
  strategy: password({ identity: User.fields.email }),
})

const Users = crud(User, { methods: ["list", "get"] })     // read-only
const Venues = crud(Venue, { auth: false })                 // public catalog
const Bookings = crud(Booking, {                            // no update
  methods: ["list", "get", "create", "delete"],
})
const BookingCount = count(Booking)

const MainDB = postgres({ entities: [User, Venue, Booking] })

const Server = fastapi({
  title: "Booking API",
  // the tech stack is part of the specification — exact pins
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
  services: [MainAuth, Users, Venues, Bookings, BookingCount],
  resources: [MainDB],
})

export default defineApp({
  name: "BookingAPI",
  entities: [User, Venue, Booking],
  services: [MainAuth, Users, Venues, Bookings, BookingCount],
  resources: [MainDB, Server],
})
```

Check it first — invalid specs never reach the agent:

```bash
pnpm spec check examples/booking/app.spec.ts
```

## 2. Plan without paying (`--dry-run`)

```bash
pnpm spec generate examples/booking/app.spec.ts --dry-run
```

```
✓ Plan derived: 15 routes, 3 entities, auth, 10 DAG tasks
✓ Dry run complete — artifacts in .spec (no agent run)
```

Inspect `.spec/blueprint.json` — the derived contract. Every route, its
status codes, its request shape, the exact error bodies, the auth flow.
If anything there is not what you meant, fix the **spec**: the blueprint
is a pure function of it, and the agent has no say.

`.spec/agent.tasks.json` records the lowering — the generation DAG
(tasks, dependency edges, per-task prompt hashes) and the verification
commands. Running the dry-run twice produces byte-identical files.

## 3. Generate

```bash
pnpm spec generate examples/booking/app.spec.ts --shots 3
```

For each shot the compiler creates a fresh workspace
(`out/bookingapi-1/`, `out/bookingapi-2/`, …) and the agent harness
executes the generation DAG task by task, then the compiler drops its
own conformance suite into the workspace and verifies — once:

```
✓ Plan derived: 15 routes, 3 entities, auth, 10 DAG tasks
⟳ Generating 3 independent shot(s), 10 DAG tasks each (this takes a while)…
✓ shot-1: conformance passed (first attempt, no repair) · $…  → out/bookingapi-1
✓ shot-2: conformance passed (first attempt, no repair) · $…  → out/bookingapi-2
✓ shot-3: conformance passed (first attempt, no repair) · $…  → out/bookingapi-3
✓ All shots expose an identical OpenAPI interface
✓ Generation repeatable across 3 shot(s), zero repairs
```

Every shot must pass **on the first attempt**. A failed verification is
not retried and not repaired — it is reported as
`GENERATION_NONCONFORMANT`, a specification/blueprint defect: pin the
diverging behavior in the spec or the compiler, then regenerate all
shots. (See [the golden rule](/guide/golden-rule) for why repair is
deliberately absent.)

## 4. Run the generated server

```bash
cd out/bookingapi-1
uv venv .venv && uv pip install -e .
.venv/bin/uvicorn app.main:app --reload
```

The app reads `DATABASE_URL` (a SQLAlchemy URL) and falls back to SQLite
for development. `http://127.0.0.1:8000/docs` shows the interactive API —
register a user, log in, and call the protected routes with the bearer
token.

## 5. Read the report

`.spec/agent.result.json` holds the evidence: per-shot **per-task runs**
(session, turns, cost, files produced, scope violations), the one-shot
verification results, the artifact manifest with SHA-256 content hashes
and the spec nodes each file derives from, and the interface-equality
verdict.

## What happens

```
.spec.ts
  │  parse → resolve → normalize → validate → link     (deterministic)
  ▼
Spec IR
  │  @spec/fastapi lowering (pure function)
  ▼
BackendBlueprint ──► generation DAG (tasks, edges, prompts — deterministic)
  │                        │
  │                        ▼  agent harness: claude -p per task,
  │                           topological order, scope-audited
  │                   generated FastAPI app in out/<app>-<n>/
  ▼
conformance suite (compiler-owned pytest) ──► verification (ONE attempt)
  │
  ▼
repeatability report (.spec/agent.result.json) — no repair, ever
```

1. **Plan** — the compiler lowers the IR to a *blueprint* (a complete,
   pinned description of the backend) and then to a **generation DAG**:
   code has structure, so generation has structure —
   `project → models → schemas/security → per-entity routers → app
   wiring`, each task owning a narrow file scope and reading its
   dependencies' artifacts. `--dry-run` stops here and writes
   `blueprint.json` + `agent.tasks.json` (task graph + prompt hashes).
2. **Generate** — for each shot, a fresh workspace (`out/<app>-<n>/`) is
   created and the **agent harness** executes the DAG: one headless
   agent run per task, in topological order, with a per-task audit of
   produced files and scope violations.
3. **Verify — once** — the compiler drops its own pytest conformance
   suite into the workspace and runs the verification plan
   (`uv venv --clear`, `uv pip install -e '.[dev]'`, import check,
   `pytest conformance`). **There is no repair**: a failed first
   verification is a specification defect — pin the contract and
   regenerate (see [the golden rule](/guide/golden-rule)).
4. **Repeat** — N independent shots (default 3) must all pass the
   *same* suite on the first attempt and expose the *same* normalized
   OpenAPI interface.

## CLI options

| Flag | Meaning | Default |
| --- | --- | --- |
| `--shots <n>` | independent generations per spec | `3` |
| `--dry-run` | plan only (blueprint + DAG), no agent | — |
| `--out <dir>` | generated-app root | `out/` |
| `--model <id>` | agent model | `SPEC_AGENT_MODEL` or `glm-5.3-flash` |
| `--max-turns <n>` | agent turn budget per task | `60` |

Exit code `1` means a shot failed its first verification or shots
diverged — the golden rule was not satisfied. There is deliberately no
repair option: fix the spec/blueprint and regenerate.

## Artifacts

| File | Content |
| --- | --- |
| `.spec/blueprint.json` | the pinned behavioral contract |
| `.spec/agent.tasks.json` | the generation DAG (tasks, edges, prompt hashes) |
| `.spec/agent.result.json` | per-shot per-task runs, verification, artifacts, repeatability |
| `out/<app>-<n>/` | the generated application (runnable) |

The agent never grades itself: verification commands and the conformance
suite are produced by the compiler and dropped after generation.
