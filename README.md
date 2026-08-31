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
        ▼  lowering: blueprint + conformance suite + agent tasks
   Coding agent ──► generated FastAPI app   agentic half (Claude Code)
        │
        ▼  compiler-owned conformance suite + OpenAPI equality
   Verified, repeatable software            golden rule
```

## The golden rule: generation is repeatable

The spec is the program. Generating the same specification N times must
produce software that **behaves the same**: same interface, same APIs,
same features, same responses. `spec generate` enforces this:

1. the compiler derives a **blueprint** — a pure, total function of the IR
   that pins every observable behavior (routes, status codes, response
   shapes, error bodies, auth flow, list ordering);
2. the compiler — not the agent — generates a **pytest conformance suite**
   from that blueprint and drops it into every generated workspace;
3. N independent generations (shots) each run the *same* suite;
4. every shot's normalized **OpenAPI interface** must be identical.

If shots diverge, the spec vocabulary or the compiler pins more of the
contract — the agent never gets to decide observable behavior.


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

Generate a RESTful API server from a backend specification (requires the
`claude` CLI on PATH):

```bash
pnpm spec generate examples/booking/app.spec.ts --shots 2
```

`spec build` writes deterministic artifacts:

```
.spec/
├── spec.ir.json      # the Spec IR (versioned, sorted, byte-stable)
├── diagnostics.json  # structured diagnostics (machine protocol)
└── manifest.json     # spec + compiler + package versions (reproducibility)
```

`spec generate` additionally writes `blueprint.json` (the pinned behavioral
contract), `agent.tasks.json` (the agentic lowering), and
`agent.result.json` (per-shot verification + repeatability report), and
places the generated applications in `out/<app>-<n>/`.

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
| `@spec/fastapi`      | Backend target: blueprint lowering + conformance suite + verification plan |
| `@spec/agent`        | Coding-agent bridge: headless Claude Code runner, shot orchestration, repeatability harness |
| `@spec/compiler`     | Static compiler: TS AST → Spec IR (deterministic, structured diagnostics) |
| `@spec/cli`          | `spec check` / `spec build` / `spec inspect` / `spec generate` |

Dependency direction (enforced by architecture):

```
core ◄─ package-sdk ◄─ domain packages (web, auth, postgres, fastapi)
core ◄─ compiler ◄─ cli ──► agent (Claude Code bridge)
```

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
--shots <n>         independent generations (default 2) — all must conform
                    and expose an identical OpenAPI interface
--dry-run           plan only (blueprint + tasks), no agent
--out <dir>         generated-app root (default "out/")
--model <id>        agent model (default SPEC_AGENT_MODEL)
--repair-rounds <n> verification failures fed back for repair (default 2)
--max-turns <n>     agent turn budget (default 60)
```

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

Three structurally different applications, all held to the golden rule:

| Example | Purpose | Size | Features |
| --- | --- | --- | --- |
| `examples/cblog` | content CMS | 3 entities | auth, two-level refs, full CRUD, all routes protected |
| `examples/inventory` | inventory service | 2 entities | **no auth**, string uniques, defaults, count endpoint, `/api/v1` prefix |
| `examples/booking` | reservation service | 3 entities | mixed public/protected, datetime fields, partial CRUD subsets, count |

```bash
pnpm spec generate examples/cblog/app.spec.ts --shots 2
pnpm spec generate examples/inventory/app.spec.ts --shots 2
pnpm spec generate examples/booking/app.spec.ts --shots 2
```

Each run generates independent applications, judges them with the same
compiler-derived conformance suite, and diffs their OpenAPI interfaces.
Measured results for all three (2 shots each, all conformant, all
interface-identical) are recorded in
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
