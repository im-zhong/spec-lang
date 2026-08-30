# spec — Specification Programming MVP

A TypeScript-based **Specification Programming** prototype.

You describe software in a restricted TypeScript DSL (`.spec.ts` files),
extend domain vocabulary through **specification packages**, and compile
everything into a **deterministic, versioned Spec IR** with **structured
diagnostics** — a stable, verifiable, reproducible input for future
AI-agent-driven software generation.

```
Specification (.spec.ts)
        │  TypeScript Compiler API (static analysis — user code is never executed)
        ▼
     Spec IR  ──►  Diagnostics
        │
        ▼  (future: agentic / verification / lowering passes)
   Artifacts
```

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

`spec build` writes deterministic artifacts:

```
.spec/
├── spec.ir.json      # the Spec IR (versioned, sorted, byte-stable)
├── diagnostics.json  # structured diagnostics (machine protocol)
└── manifest.json     # spec + compiler + package versions (reproducibility)
```

## A specification

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

Compiling this spec produces an IR expressing the application, entities,
fields, the auth service with its password strategy and identity, the
PostgreSQL resource, package dependencies, capabilities, and source
locations for every node.

## Packages

| Package              | Role                                                        |
| -------------------- | ----------------------------------------------------------- |
| `@spec/core`         | Core abstractions: SpecNode, Diagnostic, Capability, Spec IR, `defineApp`/`ref`/`constraint` |
| `@spec/package-sdk`  | Authoring SDK: `definePackage`, `defineNode`, `defineValidator`, `provides`/`requires` |
| `@spec/web`          | Domain package: `entity`, `field`, `page`, `api`            |
| `@spec/auth`         | Domain package: `auth`, `password` (requires `RelationalStore`) |
| `@spec/postgres`     | Domain package: `postgres` (provides `RelationalStore`)     |
| `@spec/compiler`     | Static compiler: TS AST → Spec IR (deterministic, structured diagnostics) |
| `@spec/cli`          | `spec check` / `spec build` / `spec inspect`                |

Dependency direction (enforced by architecture):

```
core ◄─ package-sdk ◄─ domain packages (web, auth, postgres)
core ◄─ compiler ◄─ cli
```

The compiler contains **no** domain logic — all web/auth/postgres
semantics live in their packages and are registered as validators,
capabilities and inspectors through the `SpecPackage` interface.

## CLI

```text
spec check <file>     parse + resolve + validate + link (no artifacts)
spec build <file>     full compile, writes artifacts to .spec/ (configurable)
spec inspect <file>   print the specification tree
```

Exit codes: `0` success · `1` specification error · `2` compiler/internal
error (use `--debug` for stack traces).

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

## Tests

```bash
pnpm test          # builds all packages, then runs vitest
```

Includes unit tests (core/web/auth/postgres), compiler tests, golden
compiler tests (`tests/fixtures/*/expected/`), a determinism test
(100 consecutive compiles → identical SHA-256), and CLI integration
tests exercising both acceptance specs. Regenerate goldens with
`node tests/update-golden.mjs` after an intentional IR change.

## Non-goals (MVP)

No code generation, no LLM/agent runtime, no formal verification, no
package registry, no IDE/LSP tooling. The architecture reserves extension
points for all of these (agentic passes, verification passes, lowering
rules, agent task/artifact models in `@spec/core`).

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
