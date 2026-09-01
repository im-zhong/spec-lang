# Quickstart

Requirements: **Node.js >= 20**, **pnpm >= 9** — plus, for generation:
the `claude` CLI on `PATH`, `uv`, and Python 3.10+.

## 1. Install and build

```bash
git clone <repository> spec-lang
cd spec-lang
pnpm install
pnpm build
```

This builds all workspace packages (`@spec/core`, `@spec/web`,
`@spec/auth`, `@spec/postgres`, `@spec/fastapi`, `@spec/agent`,
`@spec/compiler`, `@spec/cli`).

::: tip
Run `pnpm test` to verify the installation. The current suite has 89 local
tests plus 3 opt-in live-agent E2E tests; the latter run only when
`SPEC_AGENT_E2E=1`.
:::

## 2. Inspect the example app

The repository ships with examples in `examples/`. The static-only one is
`examples/basic-web-app/app.spec.ts`:

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

## 3. Check, build, inspect

```bash
pnpm spec check   examples/basic-web-app/app.spec.ts
pnpm spec build   examples/basic-web-app/app.spec.ts
pnpm spec inspect examples/basic-web-app/app.spec.ts
```

`spec check` statically validates the specification:

```
✓ Specification valid
```

`spec build` compiles it and writes artifacts:

```
✓ Specification compiled
✓ IR written to .spec/spec.ir.json
```

`spec inspect` prints a human-readable tree:

```
Application ExampleApp

Entities
└── User
    ├── email: email [unique]
    ├── id: uuid
    └── name: string

Services
└── MainAuth
    ├── principal: User
    └── password
        └── identity: User.email

Resources
└── PostgreSQL
    └── entities: User
```

## 4. The artifacts

```
.spec/
├── spec.ir.json      # the Spec IR: versioned, key-sorted, byte-stable
├── diagnostics.json  # structured diagnostics (machine protocol)
└── manifest.json     # spec/compiler/package versions for reproducibility
```

The build is **deterministic**: compiling the same file twice produces a
byte-identical `spec.ir.json` (same SHA-256). See
[Spec IR & determinism](/guide/ir).

## 4b. Generate a running server

The same specification can be *implemented*, not just checked. Take one
of the golden-rule examples — `examples/inventory` is the smallest — and
plan a generation first:

```bash
pnpm spec generate examples/inventory/app.spec.ts --dry-run
```

```
✓ Plan derived: 11 routes, 2 entities
✓ Dry run complete — artifacts in .spec (no agent run)
```

`.spec/blueprint.json` now holds the full behavioral contract (exact
routes, status codes, response shapes, error bodies). To actually build
the software, drop `--dry-run` and ask for independent generations:

```bash
pnpm spec generate examples/inventory/app.spec.ts --shots 2
```

The coding agent writes a complete FastAPI backend per shot
(`out/inventoryapi-1/`, `out/inventoryapi-2/`). The compiler then starts
each generated app through FastAPI `TestClient`, sends real HTTP requests
against an isolated database, and checks exact responses and state changes.
Every shot must pass that same suite once; normalized OpenAPI interfaces
must also match — the [golden rule](/guide/golden-rule).
Run the result:

```bash
cd out/inventoryapi-1
uv venv .venv && uv pip install -e ".[dev]"
.venv/bin/uvicorn app.main:app --reload
```

## 5. Break it (on purpose)

Change the auth identity to a field of another entity:

```ts
const Product = entity("Product", { id: field.uuid() })

const MainAuth = auth({
  principal: User,
  strategy: password({ identity: Product.fields.id }), // ✗ wrong entity
})
```

Then:

```bash
pnpm spec check examples/basic-web-app/app.spec.ts
```

```
✗ Specification invalid

AUTH_IDENTITY_NOT_IN_PRINCIPAL
examples/basic-web-app/app.spec.ts:21:13

Auth identity Product.id does not belong to principal entity "User".
```

The command exits with code `1` and a diagnostic that names the rule, the
location and the offending value. See [Diagnostics](/guide/diagnostics).

## Where to go next

- [The .spec.ts language](/guide/language) — what you can and cannot write
- [Entities & fields](/guide/entities) — the data model DSL
- [REST resources](/guide/rest-resources) — crud, count and references
- [Agentic generation](/guide/generate) — from spec to running software
- [The golden rule](/guide/golden-rule) — why generation is repeatable
- [Source walkthrough](/deep-dive/source-walkthrough) — one spec traced
  through every stage, at the source-code level
- [Authoring spec packages](/guide/package-authoring) — extend the language
