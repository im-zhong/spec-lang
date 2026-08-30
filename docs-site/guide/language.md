# The .spec.ts language

A specification is a TypeScript file with the extension `.spec.ts`. You
write normal TypeScript — imports, consts, calls — but the file is
interpreted **statically**: the compiler parses it with the TypeScript
Compiler API and evaluates a restricted subset. A specification is never
executed as a JavaScript program.

## Anatomy

Every specification file has the same shape:

```ts
// 1. import vocabulary from spec packages
import { defineApp } from "@spec/core"
import { entity, field } from "@spec/web"

// 2. declare spec nodes as consts
const User = entity("User", {
  id: field.uuid(),
})

// 3. export the application root
export default defineApp({
  name: "Demo",
  entities: [User],
})
```

Three things are allowed at the top level:

| Construct          | Purpose                                            |
| ------------------ | -------------------------------------------------- |
| `import { x } from "pkg"` | Bring vocabulary from spec packages into scope |
| `const Name = ...`       | Declare a spec node (or a plain value)         |
| `export default ...`     | Define the application root                    |

## Allowed expressions

Inside declarations you may use:

- **Literals** — strings, numbers, booleans, `null`
- **Identifiers** — consts defined earlier in the file, or imports
- **Property access** — e.g. `User.fields.email`, `options.mode`
- **Calls** — to imported package functions (`entity(...)`) or methods on
  their results (`field.email().unique()`)
- **Object literals** — `{ key: value }`
- **Array literals** — `[a, b]`

Anything else — operators, template literals, ternaries, spreads, arrow
functions — is rejected with a `SPEC_UNSUPPORTED_SYNTAX` diagnostic.

::: warning Type annotations
Type annotations and type-only imports are erased by the parser and carry
no semantic meaning. The spec DSL itself is strongly typed via its
builders.
:::

## Forbidden constructs

Specifications must be pure descriptions. The compiler rejects:

| Category                      | Examples                                   |
| ----------------------------- | ------------------------------------------ |
| Control flow                  | `while`, `do`, `for`, `for...of`, `for...in` |
| Dynamic code                  | `eval(...)`, `new Function(...)`           |
| Dynamic imports               | `import("...")`                            |
| Async execution               | `await`, arbitrary async                   |
| Nondeterminism                | `Date.now`, `Math.random`                  |
| Process access                | `process.env`, `process.exit`              |
| Filesystem / network imports  | `fs`, `node:fs`, `http`, `net`, …          |
| Mutable / structural code     | `let`, `var`, function declarations, classes, enums |

Each violation produces a structured diagnostic pointing at the exact
source location:

```
SPEC_UNSUPPORTED_SYNTAX
app.spec.ts:14:1

Loops are not allowed in specifications.
```

## Why the restriction?

Two reasons:

1. **Determinism.** A specification must compile to the same IR every
   time. Anything that executes, reads the environment, or branches on
   runtime state breaks that guarantee.
2. **Security.** The compiler treats your spec as *untrusted data* and
   package code as *trusted code*. Only trusted builders are ever
   invoked — and only with arguments the compiler derived statically.
   This boundary is what makes it safe to feed specifications from
   arbitrary authors into automated tooling.

## Node identity and naming

Every declared node gets a **deterministic id** of the form `kind:name`:

```ts
const User = entity("User", { ... })  // id: "entity:User"
```

Builders that don't take a name (like `auth(...)` or `postgres(...)`)
adopt the name of their `const` binding:

```ts
const MainAuth = auth({ ... })        // id: "auth:MainAuth"
const MainDB = postgres({ ... })      // id: "postgres:MainDB"
```

Nested anonymous nodes (e.g. the password strategy inside an auth node)
derive their id from the parent id plus an index. Node ids are stable
across compilations — they are the join key between the IR, diagnostics
and future artifacts.

## What's in a name?

The `const` name and the builder name are independent:

```ts
const User = entity("User", { ... })   // name comes from the argument
const MainDB = postgres({ ... })       // name comes from the const
```

The IR records the node's `name` and its `source` location, so you can
always trace a node back to `app.spec.ts:9:14`.
