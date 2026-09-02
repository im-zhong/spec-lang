# Architecture

This document explains how the MVP implements `docs/spec.md` and where the
future extension points are.

## Overview

```
app.spec.ts
    │
    ▼  Parse        TypeScript Compiler API + spec syntax restrictions
Spec AST (imports, statements)
    │
    ▼  Resolve      load trusted spec packages (Node.js resolution)
package exports + SpecPackage definitions
    │
    ▼  Normalize    static evaluation → node builders → SpecNodes with
    │               deterministic ids and source locations
    ▼  Validate     package validators (layer 4: package semantics)
    ▼  Link         capability requirements vs providers (layer 5)
    ▼  Lower        extension point (agentic / verification passes later)
    ▼  Emit         Spec IR + manifest + diagnostics (stable JSON)
```

MVP implementation: `Parse → Resolve → Normalize → Validate → Link → Lower → Emit`
as explicit `CompilerPass`es over a `Compilation` state object, orchestrated in
`packages/compiler/src/compiler.ts`.

## Key design decisions

### 1. User specifications are never executed

The compiler reads `.spec.ts` files through the TypeScript Compiler API and
**statically evaluates** the allowed expression subset
(`packages/compiler/src/evaluate.ts`):

- literals, identifiers (local consts / imports), property access, calls,
  array and object literals — nothing else;
- calls dispatch only to functions imported from trusted spec packages (or
  methods on their results, e.g. the chainable `field.email().unique()`);
- forbidden constructs (loops, dynamic import, `eval`, `process.env`,
  `Date.now`, `Math.random`, filesystem/network imports, `let`/`var`,
  functions/classes) produce `SPEC_UNSUPPORTED_SYNTAX`-family diagnostics.

Security boundary (spec §33/§55): the compiler executes **trusted package
code only** (builders + validators from published spec packages, loaded via
`spec.entry` in their `package.json`). Untrusted user specification code is
data, not a program.

### 2. Builders produce plain data

DSL functions (`entity`, `auth`, `postgres`, `defineApp`, …) are ordinary
functions in their packages that return **node builders** — plain objects
marked with `__specNodeBuilder`. The evaluator invokes them with statically
derived arguments and annotates results with `SourceLocation`s. Because
builders are data, the compiler can serialize them deterministically
(`serializeValue` in `@spec/core`: sorted keys, functions dropped, field
specs flattened).

Anonymous nodes adopt the name of their `const` binding (`MainAuth`),
which keeps node ids (`kind:name`) deterministic and traceable to source.
Nested anonymous nodes (e.g. the `passwordStrategy` inside an auth node)
derive their id from the parent id plus index.

### 3. Package isolation (spec §46)

The compiler core has zero knowledge of web/auth/postgres. Everything
domain-specific is registered by packages through the `SpecPackage`
interface:

- **validators** — semantic checks (`DUPLICATE_ENTITY_NAME`,
  `AUTH_IDENTITY_NOT_IN_PRINCIPAL`, `AUTH_IDENTITY_NOT_UNIQUE`, …);
- **capabilities** — `provides`/`requires` clauses; the compiler's link
  pass checks requirements generically (`MISSING_CAPABILITY_PROVIDER`,
  `DUPLICATE_CAPABILITY_PROVIDER`);
- **inspectors** — per-node-kind rendering hooks used by `spec inspect`,
  so even human output keeps domain knowledge inside packages.

The core `ValidationContext` exposes only structural queries
(`getNode`, `findNodes`, `report`).

A third party can add `@alice/spec-redis` without touching the compiler:
declare a `spec` section in `package.json`, export a
`definePackage({...})` default from the entry, and depend on nothing but
`@spec/core` / `@spec/package-sdk`.

### 4. Determinism (spec §24/§50)

- node ids derive from `package + kind + name` (or parent + index), never
  from random values or timestamps;
- `stableStringify` sorts all object keys recursively;
- node lists are sorted by id; capability lists are sorted;
- diagnostics are sorted by (file, line, column, code);
- `metadata.generatedAt` is omitted entirely, and nothing nondeterministic
  enters the IR (verified by the 100-compile SHA-256 test).

Same spec source + package versions + compiler version ⇒ byte-identical
`spec.ir.json`.

### 5. Diagnostics are a machine protocol

Every problem is a structured `Diagnostic` (`code`, `level`, `message`,
optional `source` with `file:line:column`, `nodeId`, `details`). This is
what future agents will consume for automated repair
(`Compiler → Diagnostic → Agent → Repair`).

Compiler bugs are separated from user errors: user errors are diagnostics
(exit 1); bugs raise `InternalCompilerError` (exit 2, stack traces only
with `--debug`).

### 6. Validation layers (spec §42)

| Layer | Concern                                  | Where                                |
| ----- | ---------------------------------------- | ------------------------------------ |
| 1     | TypeScript syntax                        | `parse.ts` syntax diagnostics        |
| 2     | spec syntax restrictions                 | `parse.ts` scan + `evaluate.ts`      |
| 3     | core semantics (ids, app shape)          | `pipeline.ts` normalize              |
| 4     | package semantics                        | package validators via `validatePass`|
| 5     | cross-package semantics (capabilities)   | `pipeline.ts` `linkPass`             |
| 6     | formal verification (future)             | `lowerPass` extension point          |

## Repository layout

```
packages/core         types, builder protocol, core DSL, logger, errors, stable JSON
packages/package-sdk  definePackage / defineNode / defineValidator / provides / requires
packages/web          entity / field / crud / count / page / api + validators
packages/auth         auth / password + validators (principal, identity, uniqueness)
packages/postgres     postgres resource + RelationalStore provider
packages/fastapi      backend target: blueprint lowering, conformance suite, prompts,
                      verification plan (the traditional↔agentic bridge)
packages/agent        Claude Code bridge: generation-DAG → GitHub execution,
                      shot orchestration and repeatability evidence
packages/container    OCI contracts + deterministic Dockerfile/runtime lowering
packages/execution    generic Git branch/worktree/container/PR/check/resume backend;
                      owns no application DAG
packages/compiler     parse, evaluate, loader, passes, config, inspect
packages/cli          spec check / build / inspect / generate, exit codes 0/1/2
examples/basic-web-app/           §59 acceptance specification (static only)
examples/cblog/ inventory/ booking/  golden-rule test projects (generate)
tests/fixtures/*/     golden fixtures (valid, invalid, warning, capability, syntax)
```

## The agentic pass (implemented)

The `lower` extension point is now exercised by `@spec/fastapi` +
`@spec/agent` through `spec generate`:

```
Spec IR ──(buildBlueprint, pure)──► BackendBlueprint
   blueprint pins EVERYTHING observable:
   routes, status codes, request/response shapes, exact error bodies,
   auth flow, list scope and ordering, defaults, ref semantics, db url format
        │
        ├──(buildTaskDag, deterministic)──► generation DAG
        │        project → models → schemas/security → routers → app
        │        one narrow prompt + file scope per task
        ├──(@spec/agent)──► one branch/worktree/container/PR per DAG task,
        │                   parallel ready nodes, exact-scope commits,
        │                   published parent SHAs as the only child input
        ├──(buildConformanceSuite, deterministic)──► compiler-owned pytest
        │                                            dropped into every shot
        └──(fastApiVerification)──► uv venv / install / import / pytest
                     │ ONE attempt, no repair
                     ▼
        N shots must pass the SAME suite on the FIRST attempt and expose
        the SAME normalized OpenAPI interface — the golden rule
```

Division of responsibility is strict:

- the **agent harness** writes code task-by-task along the DAG — it never
  grades itself;
- the **compiler** owns the contract, the suite and the verdict;
- there is **no repair**: a failed first verification or a divergence
  between shots is a specification/compiler defect — pin more of the
  contract and regenerate all shots.

Provenance is real: every generated file becomes an `Artifact` with a
SHA-256 content hash, `generatedBy` task id and `sourceNodes` pointing at
the SpecNodes it derives from.

## Future extension points

- `SpecLowering` + the `lower` pass — more backend targets (the fastapi
  package is the reference implementation of a target).
- GitHub-native generation execution — the original target-derived generator
  DAG is projected directly onto one digest-pinned container, branch, commit,
  PR and exact-head check per node. `@spec/execution` supplies generic durable
  mechanics but defines no second DAG. See `docs/generation-workflow.md`.
- `@spec/container` — generic, backend, and frontend OCI contracts are
  represented and validated in Spec IR, then lowered to deterministic
  Dockerfiles, context/runtime contracts, fingerprints, SBOM/provenance
  requirements and compiler-owned config/lifecycle verification.
- `AgentTask` / `AgentResult` / `Artifact` / `Constraint` types in
  `@spec/core` — the provenance chain
  `Artifact → AgentTask → SpecNode → SourceLocation` is navigable in
  `agent.result.json`.
- `spec-ir/0.2+` versioning: the IR carries `version: "spec-ir/0.1"`.
- Protobuf IR, incremental compilation, remote registry, LSP: the pass
  pipeline and the `SpecPackage` interface are the seams.
