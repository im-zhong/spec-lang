# What is spec?

**spec** is a prototype system for *Specification Programming*: instead of
writing the implementation of an application directly, you write a
**specification** of what the application is, and a compiler turns that
specification into a stable, verifiable intermediate representation.

```
Specification (.spec.ts)
        │
        ▼
   Compiler  (static analysis — your code is never executed)
        │
        ▼
    Spec IR  ──►  structured diagnostics
        │
        ▼  blueprint → generation DAG → per-task prompts (deterministic)
   Agent harness ──► generated FastAPI backend
        │
        ▼  compiler-owned verification, ONE attempt, N repeatable shots
   Verified, repeatable software artifacts
```

The core spine is rock solid:

> **Spec → Package → Compiler → IR → Diagnostic → Blueprint → Agent → Verified software**

and the agentic pass is held to one standard: generating the same spec
twice must produce software that behaves identically (see
[the golden rule](./golden-rule)).

To see all of it working on one concrete example — every function, every
data structure, every generated file — read the
[source walkthrough](/deep-dive/source-walkthrough).

## Why a specification language?

When an AI agent (or a formal verifier, or a code generator) is asked to
build software from a prompt, it works from ambiguous, unverifiable input.
A specification language changes that contract:

- **Stable input** — the Spec IR is deterministic and versioned, so the
  same spec always yields the same input for downstream tools.
- **Verifiable** — semantic rules (an auth identity must belong to the
  principal entity) are checked by the compiler, not discovered at
  runtime.
- **Traceable** — every node in the IR points back to a file, line and
  column, forming the provenance chain
  `Artifact → AgentTask → SpecNode → SourceLocation`.
- **Repairable** — problems are structured diagnostics with codes and
  details, a protocol an agent can consume to fix the spec.

## Why TypeScript as the host language?

You write specifications in ordinary TypeScript files (`*.spec.ts`):

```ts
import { defineApp } from "@spec/core"
import { entity, field } from "@spec/web"

const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
})

export default defineApp({
  name: "Demo",
  entities: [User],
})
```

You keep type inference (`User.fields.email` is fully typed), editors,
formatters and version control. But the specification is **not treated as
a program**: the compiler reads the TypeScript AST and statically extracts
meaning. See [the language guide](/guide/language) for the allowed subset.

## Core concepts

| Concept      | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| Spec file    | A `*.spec.ts` file describing one application                            |
| Spec node    | The universal unit of meaning (`entity`, `auth`, `postgres`, …)          |
| Package      | A composable semantic compiler extension: vocabulary + validators + capabilities |
| Capability   | A semantic contract between packages (`RelationalStore`, `Cache`, …)     |
| Diagnostic   | A structured error/warning with code, level, source location and details |
| Spec IR      | The deterministic, versioned, JSON-serializable compilation result      |

## The packages

| Package             | Role                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| `@spec/core`        | Core abstractions: `SpecNode`, `Diagnostic`, `Spec IR`, `defineApp`      |
| `@spec/package-sdk` | Authoring SDK for writing your own spec packages                        |
| `@spec/web`         | Web domain: `entity`, `field`, `crud`, `count`, `page`, `api`           |
| `@spec/auth`        | Authentication: `auth`, `password`                                      |
| `@spec/postgres`    | Database resource: `postgres` (provides `RelationalStore`)              |
| `@spec/fastapi`     | Backend target: blueprint, generation DAG, conformance suite            |
| `@spec/agent`       | Agent harness: DAG execution, verification, repeatability               |
| `@spec/compiler`    | The static compiler                                                     |
| `@spec/cli`         | The `spec` command line tool                                            |

Dependency direction is strictly one-way — domain packages never depend on
the compiler, and the compiler contains zero domain logic:

```
core ◄─ package-sdk ◄─ domain packages (web, auth, postgres, fastapi)
core ◄─ compiler ◄─ cli ──► agent (Claude Code harness)
```

## What's next?

Follow the [Quickstart](/guide/quickstart) to compile your first
specification, then read the [language guide](/guide/language).
