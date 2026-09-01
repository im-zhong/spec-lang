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
  tasks: AgentTask[]                          // fastapi:implement, fastapi:conform
  conformance: { files: Record<string, string> }  // compiler-owned suite
  verification: VerificationPlan              // commands to run
  stable: string                              // byte-stable form (fingerprint)
}
```

`AgentTask` comes from `@spec/core` (the types reserved since the MVP):

```ts
interface AgentTask {
  id: string          // "fastapi:implement" | "fastapi:conform"
  type: string        // "generate" | "verify"
  input: unknown      // the blueprint for implement; commands for verify
  constraints: Constraint[]
  context: { specNodeIds: string[] }   // provenance: which IR nodes
}
```

Prompts (`implementPrompt`, `repairPrompt`) are **pure functions of the
blueprint** — no timestamps, no session state — so identical specs produce
identical prompts. `agent.tasks.json` records the task list plus a SHA-256
of the implement prompt as a determinism fingerprint.

## The agent runner

`ClaudeCodeAgentRunner` (`packages/agent/src/runner.ts`) drives the
`claude` CLI headlessly inside a workspace:

```
claude -p --output-format json --permission-mode acceptEdits \
       --max-turns <n> --model <id> \
       --allowedTools Read Glob Grep LS Edit Write \
                     Bash(uv:*) Bash(python:*) Bash(pytest:*) …
```

- the prompt arrives on **stdin**; the result is parsed from the JSON on
  stdout (session id, cost, turns, duration)
- the tool allowlist is deliberately narrow: file tools plus the Python
  toolchain. `rm` is absent — repair agents must not be able to destroy
  workspaces
- wall-clock budget per run (45 min default), because slow model gateways
  otherwise hang shots forever

The runner is a code-writing engine only. It never grades anything —
verification is compiler-side.

## The shot lifecycle

`runShot()` (`packages/agent/src/orchestrate.ts`) executes one independent
generation:

```
1. prepareWorkspace()   fresh dir, marked .spec-generated
                       (only marked dirs may ever be wiped)
2. agent implements     implementPrompt → claude -p → code written
3. drop the suite       conformance/ files written by the COMPILER,
                       overwriting anything the agent put there
4. verify               setup commands, then check commands
5. repair loop          on failure: repairPrompt(failure) → agent
                       (bounded, default 2 rounds); the suite is
                       re-dropped before every re-check
6. scan artifacts       every file → Artifact with sha256 + provenance
```

### The conformance suite

Four files, generated from the blueprint (`packages/fastapi/src/conformance.ts`),
dropped into every workspace:

| File | Content |
| ---- | ------- |
| `conformance/conftest.py` | `client` fixture — fresh `create_app(database_url="sqlite:///<tmp>")` + `TestClient` per test |
| `conformance/helpers.py` | `body_for(entity)` builds valid create bodies (seeding ref targets recursively, principals via `/auth/register`), `create_row`, `auth_user` / `auth_token` |
| `conformance/test_contract.py` | the assertions (below) |
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

Test values that must be unique are generated per call
(`uuid`-based), so the suite itself never collides with unique
constraints.

### The verification plan

`fastApiVerification()` — idempotent, re-runnable across repair rounds:

| Step | Command | Budget |
| ---- | ------- | ------ |
| `venv` | `uv venv .venv --clear --quiet` | 2 min |
| `install` | `uv pip install --quiet -e '.[dev]'` | 10 min |
| `import` | `.venv/bin/python -c "from app.main import app, create_app; assert app.title"` | 1 min |
| `conformance` | `.venv/bin/python -m pytest conformance -q` | 5 min |

(`--clear` matters: `uv venv` refuses to recreate an existing venv, which
once sent repair agents chasing a phantom failure.)

## Artifacts and provenance

After a shot passes, every workspace file becomes a core `Artifact`:

```ts
interface Artifact {
  id: string          // "artifact:app/main.py"
  type: "source" | "config" | "test" | "document" | "verification"
  path: string        // workspace-relative
  contentHash: string // sha256
  generatedBy: string // "fastapi:implement"
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
else                                            → INTERFACE_DIVERGENT (error)
ok = all conformant AND (single shot OR interfaces identical)
```

The snapshot normalizes each shot's `/openapi.json` to exactly:

```ts
{ "GET /posts": { statuses: [...], pathParams: [...], requestBody: bool } }
```

Agent naming (operationIds, tags, descriptions) is dropped by
construction — only client-observable interface facts are compared.

## `agent.result.json`

Written to the output dir after a run (nondeterministic by nature —
session ids, costs, timings — and therefore gitignored):

```ts
{
  ok: boolean
  interfaceEqual: boolean
  totalCostUsd: number
  shots: Array<{
    shot: string                       // "shot-1"
    workspace: string
    ok: boolean
    repairs: Array<{                   // what failed, what fixed it
      round: number
      fixed: string                    // failing step name
      failureOutput: string            // command output tail
      run: { ok, turns, costUsd }
    }>
    generate: { ok, sessionId, turns, costUsd }
    verification: { setup: CommandResult[]; check: CommandResult[] }
    artifacts: Artifact[]
    diagnostics: Diagnostic[]
  }>
  diagnostics: Diagnostic[]            // AGENT_*, REPEATABLE, INTERFACE_*
}
```

Generation diagnostics (`AGENT_TASK_FAILED`, `AGENT_VERIFICATION_FAILED`,
`INTERFACE_DIVERGENT`, …) follow the same structured protocol as compiler
diagnostics — see the [diagnostics reference](/reference/diagnostics).
