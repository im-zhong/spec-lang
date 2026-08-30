# Quickstart

Requirements: **Node.js >= 20** and **pnpm >= 9**.

## 1. Install and build

```bash
git clone <repository> spec-lang
cd spec-lang
pnpm install
pnpm build
```

This builds all workspace packages (`@spec/core`, `@spec/web`,
`@spec/auth`, `@spec/postgres`, `@spec/compiler`, `@spec/cli`).

::: tip
Run `pnpm test` to verify the installation — 40+ unit, golden,
determinism and integration tests should pass.
:::

## 2. Inspect the example app

The repository ships with the canonical example in
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
- [Authoring spec packages](/guide/package-authoring) — extend the language
