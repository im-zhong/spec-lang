# spec — Specification Programming

A TypeScript-based **Specification Programming** prototype that combines a
**traditional compiler** with a **coding agent**.

You describe software in a restricted TypeScript DSL (`.spec.ts` files),
extend domain vocabulary through **specification packages**, and compile
everything into a **deterministic, versioned Spec IR** with **structured
diagnostics**. A backend target (`@spec/fastapi`) then lowers the IR to a
pinned behavioral contract, and a coding agent (Claude Code, headless)
implements it — verified against a compiler-generated **conformance suite**.

```
Specification (.spec.ts)
        │  TypeScript Compiler API (static analysis — user code is never executed)
        ▼
     Spec IR ──► Diagnostics                traditional half (deterministic)
        │
        ▼  lowering: blueprint → generation DAG → per-task prompts
   Agent harness ──► generated FastAPI app  agentic half (Claude Code)
        │
        ▼  compiler-owned conformance suite, ONE attempt + OpenAPI equality
   Verified, repeatable software            golden rule (no repair)
```

## The golden rule: generation is repeatable

The spec is the program. Generating the same specification N times must
produce software that **behaves the same**: same interface, same APIs,
same features, same responses. `spec generate` enforces this:

1. the compiler derives a **blueprint** — a pure, total function of the IR
   that pins every observable behavior (routes, status codes, response
   shapes, error bodies, auth flow, list scope and ordering);
2. the compiler lowers the blueprint to a **generation DAG**
   (project → models → schemas/security → routers → app) and an agent
   harness executes it — one narrowly-scoped agent run per task, in
   dependency order, with per-task file-scope auditing;
3. the compiler — not the agent — generates a **pytest conformance suite**
   from that blueprint and drops it into every generated workspace;
4. every shot must pass it **on the first attempt** (there is no repair),
   and every shot's normalized **OpenAPI interface** must be identical.

If a shot fails or shots diverge, that is a specification defect: the
spec vocabulary or the compiler pins more of the contract, and all shots
are regenerated. The agent never gets to decide observable behavior, and
nothing ever gets patched until it passes.


## Quick start

Requires Node.js >= 20 and pnpm >= 9.

```bash
pnpm install
pnpm build
pnpm test
```

Compile the example application:

```bash
pnpm spec check   examples/basic-web-app/app.spec.ts   # static semantic check
pnpm spec build   examples/basic-web-app/app.spec.ts   # writes .spec/ artifacts
pnpm spec inspect examples/basic-web-app/app.spec.ts   # human-readable tree
```

Plan a RESTful API server from a backend specification:

```bash
pnpm spec generate examples/booking/app.spec.ts --dry-run
```

`spec build` writes deterministic artifacts:

```
.spec/
├── spec.ir.json      # the Spec IR (versioned, sorted, byte-stable)
├── diagnostics.json  # structured diagnostics (machine protocol)
└── manifest.json     # spec + compiler + package versions (reproducibility)
```

`spec generate --dry-run` writes `blueprint.json` and `agent.tasks.json`.
Execution publishes the canonical plan at `spec/generate/<run>/plan`, then
places generated products on task/final PR branches; `.spec/generation/<run>/`
is only a disposable local cache of the remote plan and result.

## A specification

A full backend — entities, RESTful CRUD resources, auth, database, server —
in one declarative file:

```ts
import { defineApp } from "@spec/core"
import { entity, field, crud } from "@spec/web"
import { auth, password } from "@spec/auth"
import { postgres } from "@spec/postgres"
import { fastapi } from "@spec/fastapi"

const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
  name: field.string(),
})

const Post = entity("Post", {
  id: field.uuid(),
  title: field.string(),
  body: field.string().optional(),
  published: field.boolean().default(false),
  author: field.ref("User"),            // foreign key
})

const MainAuth = auth({
  principal: User,
  strategy: password({ identity: User.fields.email }),
})

const Posts = crud(Post)                 // GET/POST/PATCH/DELETE /posts
const MainDB = postgres({ entities: [User, Post] })

const Server = fastapi({
  title: "Blog API",
  services: [MainAuth, Posts],
  resources: [MainDB],
})

export default defineApp({
  name: "BlogAPI",
  entities: [User, Post],
  services: [MainAuth, Posts],
  resources: [MainDB, Server],
})
```

Compiling this spec produces an IR expressing the application, entities,
fields, the auth service with its password strategy and identity, the
PostgreSQL resource, package dependencies, capabilities, and source
locations for every node. Generating it produces a FastAPI server whose
routes, status codes, response shapes, error bodies and auth flow are all
pinned by the compiler — and provably identical across generations.

## Packages

| Package              | Role                                                        |
| -------------------- | ----------------------------------------------------------- |
| `@spec/core`         | Core abstractions: SpecNode, Diagnostic, Capability, Spec IR, `defineApp`/`ref`/`constraint`, `AgentTask`/`Artifact` |
| `@spec/package-sdk`  | Authoring SDK: `definePackage`, `defineNode`, `defineValidator`, `provides`/`requires` |
| `@spec/web`          | Domain package: `entity`, `field`, `crud`, `count`, `page`, `api` |
| `@spec/auth`         | Domain package: `auth`, `password` (requires `RelationalStore`) |
| `@spec/postgres`     | Domain package: `postgres` (provides `RelationalStore`)     |
| `@spec/cache` / `@spec/redis` | Portable cache policies + Redis provider (`CacheStore`) |
| `@spec/messaging` | Messages, queues, delivery, retry, ordering and dead letters |
| `@spec/rabbitmq` / `@spec/kafka` / `@spec/sqs` | Message broker providers |
| `@spec/blob` / `@spec/s3` | Portable object-storage behavior + S3 provider |
| `@spec/container` | Digest-pinned generic/backend/frontend OCI container contracts |
| `@spec/execution` | GitHub/container/commit/PR execution backend for the compiler-owned agent DAG |
| `@spec/fastapi`      | Backend target: blueprint + generation DAG + conformance suite + verification plan |
| `@spec/agent`        | Agent harness: headless Claude Code runner, DAG execution, shot orchestration, repeatability |
| `@spec/compiler`     | Static compiler: TS AST → Spec IR (deterministic, structured diagnostics) |
| `@spec/cli`          | `spec check` / `spec build` / `spec inspect` / `spec generate` |

Dependency direction (enforced by architecture):

```
core ◄─ package-sdk ◄─ domain packages (web, auth, postgres, fastapi)
core ◄─ compiler ◄─ cli ──► agent (Claude Code bridge)
```

The generator treats uncommitted worktrees as disposable execution state. Each
node of the existing compiler-owned generation DAG gets its own branch,
digest-pinned container, commit, PR, and clean GitHub check. Children consume
only pushed parent SHAs. This is the execution model of `spec generate`, not a
second development DAG. The full contract and container-spec hierarchy are in
[`docs/generation-workflow.md`](docs/generation-workflow.md).

Plan locally without running an agent:

```bash
spec generate examples/media-platform/app.spec.ts --dry-run
```

Execute the generator DAG through GitHub:

```bash
spec generate examples/media-platform/app.spec.ts \
  --run-id media-platform-v1 \
  --image ghcr.io/OWNER/spec-agent@sha256:DIGEST \
  --effort high --max-turns 100 \
  --target-dir products/media-platform/backend \
  --shots 2 --concurrency 2
```

Add `--resume` with the same immutable arguments to reconstruct the run from
GitHub after deleting all local worktrees and containers.

The compiler contains **no** domain logic — all web/auth/postgres
semantics live in their packages and are registered as validators,
capabilities and inspectors through the `SpecPackage` interface. The agent
layer contains **no** grading logic — verification and the conformance
suite are compiler-owned.

## CLI

```text
spec check <file>     parse + resolve + validate + link (no artifacts)
spec build <file>     full compile, writes artifacts to .spec/ (configurable)
spec inspect <file>   print the specification tree
spec generate <file>  compile → blueprint → agent shots → conformance + repeatability
```

`spec generate` options:

```text
--shots <n>         independent generations (default 3) — all must conform
                    on the FIRST attempt and expose an identical interface
--dry-run           plan only (blueprint + DAG), no agent
--model <id>        optional model override (default: Claude CLI selection)
--effort <level>    pinned low|medium|high|xhigh|max (required to execute)
--max-turns <n>     pinned turn budget (required to execute)
--run-id <id>       stable GitHub run id (required unless --dry-run)
--image <ref>       digest-pinned agent image (required unless --dry-run;
                    may be omitted for --execution local --runtime host)
--target-dir <dir>  repository-relative generated product directory
--repository <owner/base>
                     optional temporary repository prefix; the generator
                     creates a distinct private repository for every shot
--concurrency <n>   parallel ready generator nodes (default 2)
--execution <mode>  github (default) or local — per-shot bare Git remotes on
                    this machine; fast iteration only, not golden-rule evidence
--runtime <mode>    docker (default, pinned image) or host (agent runs directly
                    in the shot worktree; host provides the toolchain)
--merge-policy <p>  merge-to-main (default; deterministic code merge per
                    feature node after its own tests pass), pull-request,
                    or merge-queue
--resume            continue the same run from GitHub branches/checks
```

There is deliberately no repair option: a nonconformant shot is a
specification defect (see the golden rule above).

Exit codes: `0` success · `1` specification error / generation failed the
golden rule · `2` compiler/internal error (use `--debug` for stack traces).

Output directory can be changed via `spec.config.ts`:

```ts
export default { outputDir: ".spec" }
```

## Writing your own spec package

Any package with a `spec` section in its `package.json` is loadable:

```json
{ "spec": { "package": true, "entry": "./dist/spec-package.js" } }
```

```ts
import { definePackage, defineValidator, provides } from "@spec/package-sdk"

export default definePackage({
  name: "@alice/spec-redis",
  version: "0.1.0",
  capabilities: [provides("Cache")],
  validators: [/* ... */],
})
```

No compiler changes required — the compiler discovers packages through
ordinary Node.js module resolution from your spec file.

## Test projects (anti-overfitting)

Four structurally different applications, all held to the golden rule:

| Example | Purpose | Size | Features |
| --- | --- | --- | --- |
| `examples/cblog` | content CMS | 3 entities | auth, two-level refs, full CRUD, all routes protected |
| `examples/inventory` | inventory service | 2 entities | **no auth**, string uniques, defaults, count endpoint, `/api/v1` prefix |
| `examples/booking` | reservation service | 3 entities | mixed public/protected, datetime fields, partial CRUD subsets, count |
| `examples/media-platform` | production-style media operations | 10 entities / 324 spec lines | all infrastructure packages, auth, 3 lifecycles, 4 invariants, 62 routes |

```bash
pnpm spec generate examples/cblog/app.spec.ts --dry-run
pnpm spec generate examples/inventory/app.spec.ts --dry-run
pnpm spec generate examples/booking/app.spec.ts --dry-run
pnpm spec generate examples/media-platform/app.spec.ts --dry-run
```

Each run generates 3 independent applications via the generation DAG,
judges each with the same compiler-derived conformance suite on the
FIRST attempt (no repair exists), and diffs their OpenAPI interfaces.
Measured results are recorded in
[`docs/golden-rule-results.md`](docs/golden-rule-results.md), along with
every divergence the harness caught and the contract pin that fixed it.

## Tests

```bash
pnpm test          # builds all packages, then runs vitest
```

Includes unit tests (core/web/auth/postgres/fastapi/agent), compiler tests,
golden compiler tests (`tests/fixtures/*/expected/`), a determinism test
(100 consecutive compiles → identical SHA-256), Python syntax checks of
generated conformance suites, and CLI integration tests. Regenerate goldens
with `node tests/update-golden.mjs` after an intentional IR change.

## Non-goals

No formal verification, no package registry, no IDE/LSP tooling. The
architecture reserves extension points for all of these (verification
passes, lowering rules for further backend targets). Code generation via
a coding agent **is** implemented (`spec generate`) and held to the golden
rule; multi-target lowering beyond FastAPI is future work.

## Documentation

A full documentation website lives in `docs-site/` (VitePress):

```bash
pnpm docs:dev       # live-reload dev server
pnpm docs:build     # static build (also validated by dead-link checks)
pnpm docs:preview   # serve the production build
```

It covers the language, every package, the CLI, the complete diagnostic
code reference, the Spec IR format, and package authoring.

See also `docs/spec.md` for the full implementation specification and
`docs/architecture.md` for the architecture walkthrough.
