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
✓ Plan derived: 15 routes, 3 entities, auth
✓ Dry run complete — artifacts in .spec (no agent run)
```

Inspect `.spec/blueprint.json` — the derived contract. Every route, its
status codes, its request shape, the exact error bodies, the auth flow.
If anything there is not what you meant, fix the **spec**: the blueprint
is a pure function of it, and the agent has no say.

`.spec/agent.tasks.json` records the lowering — the two agent tasks, the
verification commands, and a SHA-256 fingerprint of the prompt. Running
the dry-run twice produces byte-identical files.

## 3. Generate

```bash
pnpm spec generate examples/booking/app.spec.ts --shots 2
```

For each shot the compiler creates a fresh workspace
(`out/bookingapi-1/`, `out/bookingapi-2/`), the agent implements the
blueprint, then the compiler drops its own conformance suite into the
workspace and verifies:

```
✓ Plan derived: 15 routes, 3 entities, auth
⟳ Generating 2 independent shot(s) with the coding agent (this takes a while)…
✓ shot-1: conformance passed · $1.76 → out/bookingapi-1
✓ shot-2: conformance passed (1 repair round(s)) · $1.93 → out/bookingapi-2
✓ All shots expose an identical OpenAPI interface
✓ Generation repeatable across 2 shot(s)
```

A **repair round** means the first verification failed and the failing
output was fed back to the agent — bounded by `--repair-rounds` (default
2). The suite is re-dropped before every re-check, so the agent cannot
grade itself by editing the tests.

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

`.spec/agent.result.json` holds the evidence: per-shot verification
results, every repair round (which step failed, the output tail, what it
cost), the artifact manifest with SHA-256 content hashes and the spec
nodes each file derives from, and the interface-equality verdict.

## What happens

```
.spec.ts
  │  parse → resolve → normalize → validate → link     (deterministic)
  ▼
Spec IR
  │  @spec/fastapi lowering (pure function)
  ▼
BackendBlueprint ──► agent tasks (prompts, deterministic)
  │                        │
  │                        ▼  claude -p (headless, tool-restricted)
  │                   generated FastAPI app in out/<app>-<n>/
  ▼
conformance suite (compiler-owned pytest) ──► verification
  │                                            │ failure → repair prompt
  ▼                                            ▼ (bounded rounds)
repeatability report (.spec/agent.result.json)
```

1. **Plan** — the compiler lowers the IR to a *blueprint*: a complete,
   pinned description of the backend (entities, routes, status codes,
   request/response shapes, error bodies, auth flow). `--dry-run` stops
   here and writes `blueprint.json` + `agent.tasks.json`.
2. **Generate** — for each shot, a fresh workspace (`out/<app>-<n>/`) is
   created and the agent implements the blueprint with its file tools.
   The prompt is a pure function of the blueprint.
3. **Verify** — the compiler drops its own pytest conformance suite into
   the workspace and runs the verification plan
   (`uv venv --clear`, `uv pip install -e '.[dev]'`, import check,
   `pytest conformance` — all idempotent across repair rounds).
   Failures are fed back to the agent for repair (bounded rounds).
4. **Repeat** — N independent shots must all pass the *same* suite and
   expose the *same* normalized OpenAPI interface (see
   [the golden rule](/guide/golden-rule)).

## CLI options

| Flag | Meaning | Default |
| --- | --- | --- |
| `--shots <n>` | independent generations per spec | `2` |
| `--dry-run` | plan only, no agent | — |
| `--out <dir>` | generated-app root | `out/` |
| `--model <id>` | agent model | `SPEC_AGENT_MODEL` or `claude-sonnet-4-5` |
| `--repair-rounds <n>` | verification failures fed back for repair | `2` |
| `--max-turns <n>` | agent turn budget per run | `60` |

Exit code `1` means a shot failed conformance or shots diverged — the
golden rule was not satisfied.

## Artifacts

| File | Content |
| --- | --- |
| `.spec/blueprint.json` | the pinned behavioral contract |
| `.spec/agent.tasks.json` | the agentic lowering (tasks + prompt hash) |
| `.spec/agent.result.json` | per-shot verification, repairs, artifacts, repeatability |
| `out/<app>-<n>/` | the generated application (runnable) |

The agent never grades itself: verification commands and the conformance
suite are produced by the compiler and re-dropped before every check.
