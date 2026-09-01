# Architecture

How the system is implemented, and where extension points live.

## Pipeline

```
app.spec.ts
    │
    ▼  Parse        TypeScript Compiler API + spec syntax restrictions
    │
    ▼  Resolve      load trusted spec packages (Node.js resolution)
    │
    ▼  Normalize    static evaluation → node builders → SpecNodes
    │               with deterministic ids and source locations
    ▼  Validate     package validators (package semantics)
    │
    ▼  Link         capability requirements vs providers
    │
    ▼  Lower        current no-op; reserved static extension point
    │
    ▼  Emit         Spec IR + manifest + diagnostics (stable JSON)

spec generate (target + agentic half, runs after a valid IR):
    │
    ▼  FastAPI plan pure IR → blueprint + DAG + suite + verification
    ▼  Agent shots  headless coding agent writes each workspace
    ▼  Conformance  compiler-owned pytest suite + verification plan
    ▼  Repeatability  N shots pass one runtime oracle + equal OpenAPI
```

Each static stage is a `CompilerPass` over a shared `Compilation` state,
orchestrated in `packages/compiler/src/compiler.ts`. `lowerPass()` is
currently an identity function. The FastAPI target is invoked by
`spec generate` after compilation and consumes the valid emitted IR; it
is not installed into the static `Lower` pass.

## Key design decisions

### 1. User specifications are never executed

The compiler reads `.spec.ts` files through the TypeScript Compiler API
and **statically evaluates** the allowed expression subset. Calls dispatch
only to functions imported from trusted spec packages (or methods on their
results). Forbidden constructs (loops, dynamic import, `eval`,
`process.env`, `Date.now`, filesystem/network imports) are rejected with
diagnostics.

Security boundary:

| Trusted                      | Untrusted                    |
| ---------------------------- | ---------------------------- |
| Compiler                     | User specifications          |
| Published spec packages (builders, validators) | Generated application code |

Only trusted package code runs; untrusted spec code is data.

### 2. Builders produce plain data

DSL functions (`entity`, `auth`, `postgres`, `defineApp`) return node
builders — plain objects marked with `__specNodeBuilder`. The evaluator
invokes them with statically derived arguments and annotates results with
source locations. Builders are pure data, so they serialize
deterministically.

Anonymous nodes adopt their `const` binding name, keeping ids
deterministic (`auth:MainAuth`) and traceable. Nested anonymous nodes
derive ids from parent + index.

### 3. Package isolation

The compiler core contains zero web/auth/postgres knowledge (verified by
test). Everything domain-specific reaches the compiler through the
`SpecPackage` interface:

- **validators** — semantic checks, run by the validate pass
- **capabilities** — `provides`/`requires`, checked by the link pass
- **inspectors** — per-kind rendering for `spec inspect`
- **lowerings** — reserved for future generation/verification

The core `ValidationContext` exposes only structural queries
(`getNode`, `findNodes`, `report`).

### 4. Determinism

- Node ids derive from package + kind + name — never randomness
- All JSON keys sorted recursively; lists sorted (nodes by id,
  capabilities by name, diagnostics by location)
- `generatedAt` omitted entirely
- Verified by a 100-compile SHA-256 test

### 5. Diagnostics as a machine protocol

Every problem is structured (`code`, `level`, `message`, `source`,
`nodeId`, `details`). User errors are diagnostics (exit 1); compiler bugs
raise `InternalCompilerError` (exit 2, stack traces with `--debug`).

## Validation layers

| Layer | Concern                                | Where                          |
| ----- | -------------------------------------- | ------------------------------ |
| 1     | TypeScript syntax                      | Parse pass (syntax diagnostics)|
| 2     | Spec syntax restrictions               | Parse scan + evaluator         |
| 3     | Core semantics (ids, app shape)        | Normalize pass                 |
| 4     | Package semantics                      | Package validators             |
| 5     | Cross-package semantics (capabilities) | Link pass                      |
| 6     | Behavioral conformance of generated code | `@spec/fastapi` suite + `@spec/agent` verification |

## Repository layout

```
packages/core         types, builder protocol, core DSL, logger, errors, stable JSON
packages/package-sdk  definePackage / defineValidator / provides / requires
packages/web          entity / field / crud / count / lifecycle / invariant /
                      expressions / effects + validators
packages/auth         auth / password + validators
packages/postgres     postgres resource + RelationalStore provider
packages/fastapi      backend target: blueprint, conformance suite, prompts,
                      verification plan (the traditional↔agentic bridge)
packages/agent        Claude Code bridge: headless runner, shot orchestration,
                      repeatability harness
packages/compiler     parse, evaluate, loader, passes, config, inspect
packages/cli          spec check / build / inspect / generate
examples/basic-web-app/             static-only acceptance spec
examples/cblog|inventory|booking/   golden-rule test projects (generate)
tests/fixtures/       golden fixtures (valid, invalid, warning, capability, syntax)
docs-site/            this documentation site (VitePress)
```

## The agentic division of labor

- The **agent** writes code — it never grades itself.
- The **compiler/target** owns the contract (blueprint), the runtime
  functional oracle, the interface snapshot and the verdict.
- Divergence between shots is a specification/compiler defect: pin more of
  the contract, never re-roll the agent.

Today “same behavior” means every independent shot passes the same
compiler-derived functional tests, including state transitions, guards,
effects and invariants. The harness separately requires normalized
OpenAPI equality. It does not yet perform direct cross-shot request-trace
or database-state comparison.

Provenance is real: every generated file becomes an `Artifact` with a
SHA-256 content hash, the task that generated it, and the SpecNodes it
derives from (`Artifact → AgentTask → SpecNode → SourceLocation`).

## Future extension points

- **More backend targets** — `@spec/fastapi` is the reference
  implementation of a target package (see
  [package authoring §8](/guide/package-authoring))
- **Formal verification passes** — the `lower` seam and the suite hook
- **Incremental compilation** — pass pipeline is composable
- **Remote package registry** — package loading is isolated in the loader
- **Protobuf IR** — IR is versioned; JSON is one encoding

The long-term shape:

```
Specification
      │
      ▼
  Compiler
      │
      ▼
  Spec IR
      │
      ├── deterministic passes
      ├── agentic passes
      ├── verification passes
      └── lowering passes
      │
      ▼
Verified Reproducible Software
```
