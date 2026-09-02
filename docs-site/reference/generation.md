# Generation internals

How `spec generate` works internally — the task model, the conformance
suite, the verification plan, the artifact provenance and the
repeatability algorithm. Package map:

| Package | Responsibility |
| ------- | -------------- |
| `@spec/fastapi` | blueprint derivation, conformance suite, prompts, verification plan |
| `@spec/agent` | Claude Code runner, shot orchestration, repeatability harness |
| `@spec/cli` | `spec generate` command, reports |

## The plan

`planGeneration(ir)` (`packages/fastapi/src/lowering.ts`) lowers a valid
Spec IR into a complete, deterministic generation plan:

```ts
interface FastApiGenerationPlan {
  blueprint: BackendBlueprint                 // the contract (see blueprint ref)
  dag: GenerationDag                          // dependency-structured tasks
  agentTasks: AgentTask[]                     // core AgentTask view of the DAG
  conformance: { files: Record<string, string> }  // compiler-owned suite
  verification: VerificationPlan              // commands to run
  stable: string                              // byte-stable form (fingerprint)
}
```

## The generation DAG

Code has structure, so generation has structure. `buildTaskDag(blueprint,
ir)` (`packages/fastapi/src/dag.ts`) derives the task graph from the
blueprint's own dependencies:

```
project ──► models ──► schemas ─────────► router:<entity> ─┐
   │           │  ╲                              ▲         │
   │           │   ╲► security (auth only) ──────┘         │
   ├──► database ──────────────────────────────────────────┤
   ├──► cache ─────────────────────────────────────────────┤
   ├──► messaging ─────────────────────────────────────────┤
   └──► blob ──────────────────────────────────────────────┤
                                      router:auth ──────────┤
                                                           ▼
                                                    app (wiring)
```

```ts
interface DagTask {
  id: string          // "models" | "router:User" | "app" | …
  kind: string        // stable selector for package guidance
  label: string
  dependsOn: string[]
  scope: string[]     // files this task owns — audited by the harness
  prompt: string      // pure function of the blueprint slice
  specNodeIds: string[]  // provenance: which IR nodes
}
```

Derivation rules (all deterministic): one router task per served entity
(count routes merge into their entity's router); `security` and
`router:auth` exist only when the blueprint has auth; a router gains the
`security` dependency only when one of its routes is protected; `cache`,
`messaging` and `blob` exist only when their contracts are present; `app`
depends on every router, the database and active infrastructure tasks. The DAG is topologically
sorted (Kahn, stable by id) and fingerprinted with prompts included —
`agent.tasks.json` records the task list, edges and per-task prompt
SHA-256 hashes.

## The agent runner

`ClaudeCodeAgentRunner` (`packages/agent/src/runner.ts`) drives the
`claude` CLI headlessly inside a workspace:

```
claude -p --output-format json --permission-mode acceptEdits \
  --allowedTools <generation file/Python allowlist>
```

- the prompt arrives on **stdin**; the result is parsed from the JSON on
  stdout (session id, cost, turns, duration)
- headless sessions receive the minimal file/Python tool authorization needed
  to write and verify the scoped workspace; without it, print mode cannot ask
  a person to approve writes and returns permission denials
- model and turn-budget settings are not overridden; Claude Code uses its
  configured/default model and budget
- `--model` and `--max-turns` are appended only when the user explicitly
  supplies the corresponding CLI option
- wall-clock budget per run (45 min default), because slow model gateways
  otherwise hang shots forever

The runner is a code-writing engine only. It never grades anything —
verification is compiler-side.

## The agent harness

`AgentHarness` (`packages/agent/src/harness.ts`) executes a task DAG:

- **scheduling** — deterministic topological order (`schedule`, Kahn,
  stable by id). Tasks within a shot are sequential: two agents must
  never write the same workspace concurrently. SHOTS, by contrast, are
  independent generations in separate workspaces and run in **parallel**.
- **per-task execution** — one runner.run per task with the task's narrow
  prompt (its scope, its readable context files, its blueprint slice).
- **auditing** — the workspace is hashed before and after each task; the
  diff attributes every created/modified file to the task that made it
  and flags **scope violations** (files touched outside `scope`,
  reported as `SCOPE_VIOLATION` warnings).
- **failure semantics** — a failed task stops the chain immediately
  (`AGENT_TASK_FAILED`); dependents never run on a broken foundation.
- **infrastructure retries (not repair)** — if an agent *run itself*
  fails (CLI crash, turn-budget exhaustion), the harness re-issues the
  identical prompt once. This tolerates transport flakiness; it is not
  repair: conformance failures are never retried or patched.

## The shot lifecycle

`runShot()` (`packages/agent/src/orchestrate.ts`) executes one independent
generation — **no repair, by policy**:

```
1. prepareWorkspace()   fresh dir, marked .spec-generated
                       (only marked dirs may ever be wiped)
2. harness runs the DAG one task per agent run, topological order,
                       scope-audited
3. drop the suite       conformance/ files written by the COMPILER,
                       overwriting anything the agent put there
4. verify — ONCE        setup commands, then check commands
5. verdict              pass → AGENT_VERIFIED
                       fail → GENERATION_NONCONFORMANT (a specification
                       defect: pin the contract, regenerate all shots)
6. scan artifacts       every file → Artifact with sha256 + provenance
```

### The conformance suite

Six files, generated from the blueprint (`packages/fastapi/src/conformance.ts`),
dropped into every workspace:

| File | Content |
| ---- | ------- |
| `conformance/conftest.py` | `client` fixture — fresh `create_app(database_url="sqlite:///<tmp>")` + `TestClient` per test |
| `conformance/helpers.py` | `body_for(entity)` builds valid create bodies (seeding ref targets recursively, principals via `/auth/register`), `create_row`, `auth_user` / `auth_token` |
| `conformance/test_contract.py` | the assertions (below) |
| `conformance/test_infrastructure.py` | cache, messaging and blob behavior using deterministic in-memory adapters; provider class presence |
| `conformance/behavior_snapshot.py` | canonical cross-shot probe of HTTP interface and infrastructure behavior |
| `conformance/contract.json` | the blueprint itself, shipped with the app |

`test_contract.py` asserts, per blueprint:

- **strict interface equality** — the OpenAPI path/method set equals the
  route table exactly (no extra routes, none missing), success status
  codes present, path params named `id`
- **create** — 201, exact response key set, server uuid4 id, defaults
  applied, optionals `null`, refs echoed as ids
- **get / list / update / delete** — 200/200/200/204 semantics, partial
  PATCH, list ordered by insertion, empty body on delete
- **error bodies** — 401 `{"detail": "Not authenticated"}`, 404
  `{"detail": "Not found"}` (unknown id *and* dangling refs), 409
  `{"detail": "Already exists"}` (unique violations), 422 shape
- **auth flow** — register → login → me, wrong-password and
  unknown-identity logins, duplicate register, `/auth/me` without token,
  every protected route without a token
- **count** — `{"count": 0}` then `{"count": 1}` after a create
- **lifecycles** — declared initial state, every legal transition,
  illegal-state `409`, request-time guard pass/fail paths, and direct
  update attempts that try to change the server-controlled state
- **effects** — exact `set` values and emitted outbox event/payload shape
- **invariants** — compiler-derived minimally violating worlds for row
  checks and cross-row counts; the mutation rolls back with the pinned
  `409` body
- **cache** — policy map, set/get/delete, mutation isolation, cache-aside
  loading, policy/key errors
- **messaging** — message schema rejection, stable envelopes, queue allowlists,
  ordering and at-least-once deduplication
- **blob** — key normalization and traversal rejection, byte/MIME limits,
  put/get/delete and exact in-memory signed URLs

Test values that must be unique are generated per call
(`uuid`-based), so the suite itself never collides with unique
constraints.

### The verification plan

`fastApiVerification()` — idempotent, so re-runs and re-validations behave identically:

| Step | Command | Budget |
| ---- | ------- | ------ |
| `venv` | `uv venv .venv --clear --quiet` | 2 min |
| `install` | `uv pip install --quiet -e '.[dev]'` | 10 min |
| `import` | `.venv/bin/python -c "from app.main import app, create_app; assert app.title"` | 1 min |
| `conformance` | `.venv/bin/python -m pytest conformance -q` | 5 min |

(`--clear` matters: `uv venv` refuses to recreate an existing venv, which
once produced a phantom failure that masked the real one.)

## Artifacts and provenance

After a shot passes, every workspace file becomes a core `Artifact`:

```ts
interface Artifact {
  id: string          // "artifact:app/main.py"
  type: "source" | "config" | "test" | "document" | "verification"
  path: string        // workspace-relative
  contentHash: string // sha256
  generatedBy: string // "fastapi:dag"
  sourceNodes: string[] // the IR nodes it derives from
}
```

Venvs, caches and `conformance/` (compiler-owned) are excluded. This
closes the provenance chain promised by the architecture:
`Artifact → AgentTask → SpecNode → SourceLocation`.

## The repeatability algorithm

`runRepeatability()` (`packages/agent/src/repeatability.ts`) implements
the golden rule:

```
for each shot:            runShot()            (independent workspace)
all shots conformant?                          → REPEATABLE (info)
capture OpenAPI snapshot per shot               (deterministic python -c)
snapshots identical?                           → INTERFACE_IDENTICAL
run behavior_snapshot.py per shot
snapshots identical?                           → BEHAVIOR_IDENTICAL
else                                            → INTERFACE_DIVERGENT (error)
ok = all conformant AND interfaces identical AND behaviors identical
```

The snapshot normalizes each shot's `/openapi.json` to exactly:

```ts
{ "GET /posts": { statuses: [...], pathParams: [...], requestBody: bool } }
```

Agent naming (operationIds, tags, descriptions) is dropped by
construction — only client-observable interface facts are compared.

The three gates prove complementary properties: every shot independently
passes the same functional runtime oracle, and every shot exposes the
same normalized OpenAPI surface, and every shot produces the same canonical
infrastructure behavior snapshot. The harness does **not** claim exhaustive
equivalence for request sequences outside the compiler-derived contract.

## `agent.result.json`

Written to the output dir after a run (nondeterministic by nature —
session ids, costs, timings — and therefore gitignored):

```ts
{
  ok: boolean
  interfaceEqual: boolean
  behaviorEqual: boolean
  behaviors: Array<{ shot: string, snapshot: string | null }>
  totalCostUsd: number
  shots: Array<{
    shot: string                       // "shot-1"
    workspace: string
    ok: boolean                        // first-attempt conformance
    tasks: Array<{                     // one entry per DAG task
      id: string                       // "models" | "router:User" | …
      ok: boolean
      run: { sessionId, turns, costUsd }
      produced: Array<{ path, sha256 }>   // files this task wrote
      scopeViolations: string[]           // out-of-scope touches
      durationMs: number
    }>
    verification: { setup: CommandResult[]; check: CommandResult[] }
    artifacts: Artifact[]
    diagnostics: Diagnostic[]
  }>
  diagnostics: Diagnostic[]            // AGENT_*, GENERATION_NONCONFORMANT,
                                       // SCOPE_VIOLATION, REPEATABLE, INTERFACE_*
}
```

Generation diagnostics (`AGENT_TASK_FAILED`, `GENERATION_NONCONFORMANT`,
`INTERFACE_DIVERGENT`, …) follow the same structured protocol as compiler
diagnostics — see the [diagnostics reference](/reference/diagnostics).
