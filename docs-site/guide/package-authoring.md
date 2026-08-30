# Authoring spec packages

A **specification package** is a composable semantic compiler extension.
It provides:

- **Vocabulary** — builder functions imported by specifications
- **Semantics** — validators the compiler runs on every build
- **Capabilities** — `provides` / `requires` declarations
- **Presentation** — optional per-node-kind inspectors for `spec inspect`
- **Future** — lowering rules, agents, verifiers

Packages are ordinary npm packages. The compiler discovers them through
normal Node.js resolution from your spec file — no registry, no compiler
changes.

## 1. Package metadata

Declare your package in `package.json` with a `spec` section:

```json
{
  "name": "@alice/spec-redis",
  "version": "0.1.0",
  "main": "dist/index.js",
  "spec": {
    "package": true,
    "entry": "./dist/spec-package.js"
  }
}
```

- `spec.package: true` marks it as a spec package (imports of non-spec
  packages are rejected with `SPEC_PACKAGE_LOAD_FAILED`).
- `spec.entry` points at the module whose **default export** is your
  package definition.

## 2. The package definition

```ts
// src/spec-package.ts
import {
  definePackage,
  defineNode,
  defineValidator,
  provides,
  requires,
  diag,
} from "@spec/package-sdk"

export default definePackage({
  name: "@alice/spec-redis",
  version: "0.1.0",

  nodeKinds: [defineNode("redis")],

  capabilities: [provides("Cache")],

  validators: [validateRedis],
})
```

## 3. Vocabulary (builders)

Export builder functions from your package index. A builder receives
statically evaluated arguments and returns a **node builder** — plain data
created with `nodeBuilder` from `@spec/core`:

```ts
// src/index.ts
import { nodeBuilder, serializeValue, type SpecNodeBuilder } from "@spec/core"

export interface RedisInput {
  entities?: unknown
  url?: string
}

export function redis(input: RedisInput): SpecNodeBuilder {
  return nodeBuilder("@alice/spec-redis", "redis", undefined, {
    ...(input?.url !== undefined ? { url: input.url } : {}),
    provides: ["Cache"],
  })
}
```

Rules of thumb:

- Builders are **pure** — they must not read the environment, the clock
  or randomness (determinism).
- On semantically invalid input, **don't throw**: store the raw value in
  attributes and let your validator diagnose it with a proper diagnostic.
- Serialize non-node attribute values with `serializeValue` (it sorts
  keys, drops functions and flattens field specs).

## 4. Validators

Validators run after the whole specification is normalized. They receive
a `ValidationContext` with structural queries only:

```ts
import { defineValidator, diag } from "@spec/package-sdk"

const validateRedis = defineValidator("redis/validate", (ctx) => {
  const diagnostics = []
  for (const node of ctx.findNodes("redis")) {
    const url = node.attributes.url
    if (url !== undefined && typeof url !== "string") {
      diagnostics.push(
        diag("REDIS_URL_INVALID", "error", "redis url must be a string.", {
          nodeId: node.id,
        }),
      )
    }
  }
  return diagnostics
})
```

The context API:

| Method                  | Purpose                                    |
| ----------------------- | ------------------------------------------ |
| `ctx.findNodes(kind)`   | All nodes (recursively) of a given kind     |
| `ctx.getNode(id)`       | Look up a node by its deterministic id      |
| `ctx.nodes`             | All root nodes                              |
| `ctx.report(diag)`      | Report a diagnostic immediately             |

Cross-package checks work naturally: resolve references
(`{ nodeId: "entity:User" }`) with `ctx.getNode`, then inspect the target
node's `kind` — this is exactly how `@spec/auth` verifies that a principal
is an entity.

## 5. Capabilities

```ts
capabilities: [provides("Cache"), requires("ConfigStore")]
```

- `provides` — capabilities nodes of this package offer. Put the runtime
  list in each node's attributes (`provides: ["Cache"]`) so the link pass
  can see which *instance* provides it.
- `requires` — capabilities this package needs; satisfied by any node in
  the application whose attributes declare it provided.

The compiler checks requirements generically
(`MISSING_CAPABILITY_PROVIDER`, `DUPLICATE_CAPABILITY_PROVIDER`) — no
package needs to know about any other.

## 6. Inspectors (optional)

Give `spec inspect` a domain-rendered tree by registering an inspector
per node kind:

```ts
import type { SpecNode } from "@spec/core"

function inspectRedis(node: SpecNode) {
  return {
    label: "Redis",
    lines: [`url: ${String(node.attributes.url ?? "default")}`],
  }
}

// in definePackage:
inspectors: { redis: inspectRedis }
```

## 7. Use it

```ts
import { entity } from "@spec/web"
import { redis } from "@alice/spec-redis"

const Cache = redis({ url: "redis://localhost:6379" })

export default defineApp({
  name: "CachedApp",
  resources: [Cache],
})
```

The compiler loads `@alice/spec-redis` through ordinary module resolution,
runs its validators, links its capabilities and renders its nodes — all
without a single change to `@spec/compiler`.
