# Spec IR & determinism

The Spec IR (intermediate representation) is the compiler's output and
the stable input for everything downstream — validators today, agents and
generators tomorrow.

## The artifact

`spec build` writes `.spec/spec.ir.json`:

```json
{
  "version": "spec-ir/0.1",
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

The IR carries `version: "spec-ir/0.1"`. Breaking changes will bump to
`spec-ir/0.2`, then `spec-ir/1.0` — consumers can dispatch on the version
string. Future formats (e.g. Protobuf) may be added; JSON is the MVP
format.

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

When generated artifacts appear in later phases, "which specification
produced this code?" will be answerable by following node ids and source
locations — the data model already supports it.
