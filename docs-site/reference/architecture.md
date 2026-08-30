# Architecture

How the MVP implements the system, and where future extension points live.

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
    ▼  Lower        extension point (agentic / verification passes later)
    │
    ▼  Emit         Spec IR + manifest + diagnostics (stable JSON)
```

Each stage is a `CompilerPass` over a shared `Compilation` state,
orchestrated in `packages/compiler/src/compiler.ts`.

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
| Published spec packages (builders, validators) | Future agent output |

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
| 6     | Formal verification (future)           | Lower pass extension point     |

## Repository layout

```
packages/core         types, builder protocol, core DSL, logger, errors
packages/package-sdk  definePackage / defineValidator / provides / requires
packages/web          entity / field / page / api + validators
packages/auth         auth / password + validators
packages/postgres     postgres resource + RelationalStore provider
packages/compiler     parse, evaluate, loader, passes, stable JSON, inspect
packages/cli          spec check / build / inspect
examples/basic-web-app/app.spec.ts
tests/fixtures/       golden fixtures (valid, invalid, warning, capability, syntax)
docs-site/            this documentation site (VitePress)
```

## Future extension points

Reserved in the MVP, not yet implemented:

- **Agentic compiler passes** — the `lower` pass and `SpecLowering` hooks
- **Formal verification passes** — same seam
- **Package-specific agents/verifiers/generators** — the `SpecPackage`
  interface
- **Agent runtime** — `AgentTask` / `AgentResult` / `Artifact` /
  `Constraint` types already defined in `@spec/core`
- **Incremental compilation** — pass pipeline is composable
- **Remote package registry** — package loading is isolated in the loader
- **Protobuf IR** — IR is versioned; JSON is one encoding
- **Reproducible software build** — manifest + deterministic IR are the
  foundation

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
