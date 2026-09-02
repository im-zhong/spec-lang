# Spec IR & determinism

The Spec IR (intermediate representation) is the compiler's output and
the stable input for everything downstream: Blueprint derivation,
generation DAGs, compiler-owned conformance suites and agent runs.

## The artifact

`spec build` writes `.spec/spec.ir.json`:

```json
{
  "version": "spec-ir/0.2",
  "app": { "name": "ExampleApp" },
  "packages": [
    { "name": "@spec/auth", "version": "0.1.0" },
    { "name": "@spec/core", "version": "0.1.0" },
    { "name": "@spec/postgres", "version": "0.1.0" },
    { "name": "@spec/web", "version": "0.1.0" }
  ],
  "nodes": [ /* SpecNode tree */ ],
  "capabilities": {
    "required": [{ "capability": "RelationalStore", "requester": "auth:MainAuth" }],
    "provided": [{ "capability": "RelationalStore", "provider": "postgres:MainDB" }]
  },
  "generation": { "contributions": [ /* package-owned target guidance */ ] },
  "diagnostics": [ /* ... */ ],
  "metadata": { "compilerVersion": "0.1.0" }
}
```

Every node is a `SpecNode`:

```ts
interface SpecNode {
  id: string                       // deterministic: "entity:User"
  kind: string                     // "entity", "auth", ...
  package: string                  // owning package
  name?: string
  attributes: Record<string, unknown>
  children?: SpecNode[]
  source?: SourceLocation          // provenance back to the .spec.ts
}
```

## Determinism guarantees

Given the same **spec source + package versions + compiler version**, the
byte content of `spec.ir.json` is identical. This is enforced by:

- **Stable node ids** — `kind:name`, derived from package, kind, name and
  source identity. Never random UUIDs.
- **Sorted keys** — all object keys are sorted recursively by the
  serializer.
- **Sorted lists** — nodes are sorted by id; capabilities by name; 
  diagnostics by source location.
- **No nondeterministic values** — `Date.now()`, `Math.random()` and
  timestamps are banned from IR identity; `metadata.generatedAt` is
  omitted entirely.

The test suite verifies it directly: compiling the example spec **100
times** must yield 100 identical SHA-256 hashes.

::: tip Why it matters
Determinism is what turns the IR into a build artifact: you can diff two
compilations, cache downstream agent work keyed on the IR hash, and
reproduce a build months later from the manifest.
:::

## Versioning

The IR carries `version: "spec-ir/0.2"`. Version 0.2 adds deterministic,
package-provenanced generation contributions and exact dependency pins.
Breaking changes bump the version string so consumers can dispatch safely.
Future formats (e.g. Protobuf) may be added; JSON is the current format.

## The manifest

`.spec/manifest.json` records everything that influenced the build:

```json
{
  "specVersion": "0.1",
  "compilerVersion": "0.1.0",
  "entry": "app.spec.ts",
  "packages": {
    "@spec/auth": "0.1.0",
    "@spec/core": "0.1.0",
    "@spec/postgres": "0.1.0",
    "@spec/web": "0.1.0"
  }
}
```

Spec + manifest together define a reproducible build: same inputs, same
IR bytes.

## Provenance

Every node carries `source: { file, line, column }`. That makes the full
chain navigable:

```
Artifact → AgentTask → SpecNode → SourceLocation
```

It is populated today: every file a `spec generate` shot produces becomes
an `Artifact` in `.spec/agent.result.json` with a SHA-256 content hash,
the DAG that generated it (`generatedBy: "fastapi:dag"`), and the
spec nodes it derives from (`sourceNodes`). "Which specification produced
this code?" is answered by following node ids back to
[file, line, column].
