# Spec IR format reference

Current version: **`spec-ir/0.3`**

## Top level

```ts
interface SpecIR {
  version: string                  // "spec-ir/0.3"
  app: { name: string }
  packages: PackageReference[]     // sorted by name
  nodes: SpecNode[]                // sorted by id
  capabilities: {
    required: CapabilityRequirement[]  // sorted by capability
    provided: CapabilityProvider[]     // sorted by capability
  }
  interfaces: {
    definitions: SpecInterfaceDefinition[] // canonical contract + SHA-256
    bindings: SpecInterfaceBinding[]        // module provides/calls
    dependencies: SpecInterfaceDependency[] // incremental invalidation edges
  }
  modules: SpecModuleDefinition[]           // includes inputHash cache keys
  generation: {
    contributions: MaterializedGenerationContribution[]
  }
  diagnostics: Diagnostic[]        // sorted by source location
  metadata: {
    compilerVersion: string
    generatedAt?: string           // omitted in the MVP (determinism)
  }
}
```

`spec-ir/0.3` adds first-class interface/module contracts and incremental
input hashes. Version 0.2 added deterministic generation contributions. Every selected
contribution is plain JSON data with `package` and `version` provenance, target,
activating node kinds, task kinds, instructions, and optional exact runtime/dev
dependency pins. Contributions are sorted by target, package and id.

An `http-json` interface operation includes a concrete
`transport: { method, path }` ABI. Link-time validation requires it, and
composite lowering proves each FastAPI provider blueprint exposes the declared
route before agent execution. With modules enabled, every concrete top-level
node must be owned by exactly one module through `contains`; missing or
overlapping ownership is invalid.

## SpecNode

```ts
interface SpecNode {
  id: string        // "entity:User" | "kind:parentId#<index>"
  kind: string      // owned by the package, e.g. "entity", "auth"
  package: string   // e.g. "@spec/web"
  name?: string
  attributes: Record<string, unknown>
  children?: SpecNode[]
  source?: SourceLocation
}
```

### Node id scheme

| Node                       | id                                    |
| -------------------------- | ------------------------------------- |
| Named (`entity("User")`)   | `entity:User`                          |
| Anonymous (`const MainAuth = auth(...)`) | `auth:MainAuth` (adopts const name) |
| Nested anonymous           | `kind:<parentId>#<index>`              |
| Duplicate names            | second node gets `#2`, `#3`, … suffix |

### Attribute value conventions

| Value in a spec          | Serialized as                                   |
| ------------------------ | ----------------------------------------------- |
| Node builder             | `{ "nodeId": "entity:User" }` (reference)       |
| Field ref (`User.fields.email`) | `{ "__fieldRef": true, "entity": "User", "field": "email", "owner": "entity:User" }` |
| Field spec builder       | flattened `{ "type": ..., "unique": ..., "target": ..., "default": ... }` |
| Plain object/array       | keys sorted recursively                        |
| Function                 | dropped (undefined)                             |

## Capabilities

```ts
interface CapabilityRequirement { capability: string; requester: string } // requester = node id
interface CapabilityProvider  { capability: string; provider: string }   // provider  = node id
```

Requirements and providers are discovered from node attributes: an array
of strings under `requires` / `provides`.

## Built-in node kinds

| Kind (package)              | Produced by                      | Key attributes                                |
| --------------------------- | -------------------------------- | --------------------------------------------- |
| `app` (`@spec/core`)        | `defineApp({...})`               | `name`, `entities`, `services`, `resources`, `modules`   |
| `interface` / `module` (`@spec/core`) | `spec.interface(...)` / `spec.module(...)` | operation contract; target and provide/call bindings |
| `entity` (`@spec/web`)      | `entity("Name", fields)`         | `fields: { [name]: { type, states?, unique?, target?, ... } }` |
| `crud` (`@spec/web`)        | `crud(Entity, opts?)`            | `entity: ref`, `path`, `methods?`, `auth`     |
| `lifecycle` (`@spec/web`)   | `lifecycle(Entity, {...})`       | `entity: ref`, enum `field`, `initial`, transitions with guard/effects |
| `invariant` (`@spec/web`)   | `invariant(name, {...})`         | `on: ref`, statically represented `check` expression |
| `page` / `api` (`@spec/web`)| `page({...})` / `api({...})`     | `path`, `title` / `method`, `operation`, `input`, `output` |
| `auth` (`@spec/auth`)       | `auth({...})`                    | `principal: ref`, `requires: [...]`           |
| `passwordStrategy` (`@spec/auth`) | `password({...})` child      | `identity: fieldRef`                          |
| `postgres` (`@spec/postgres`) | `postgres({...})`              | `entities: [ref]`, `provides: [...]`          |
| `cache` (`@spec/cache`) | `cache({...})` | provider ref, key prefix, TTL, failure and stampede behavior |
| `redis` (`@spec/redis`) | `redis({...})` | URL env, timeouts, `CacheStore` capabilities |
| `message` / `queue` (`@spec/messaging`) | `message(...)` / `queue(...)` | field schema; provider/messages refs, delivery, retry, DLQ, ordering |
| `rabbitmq` / `kafka` / `sqs` | provider builders | provider configuration and `MessageBroker` capabilities |
| `blob` (`@spec/blob`) | `blob(...)` | provider ref, bucket, prefix, limits, MIME types, URL TTL, retention |
| `s3` (`@spec/s3`) | `s3({...})` | region/endpoint envs, addressing mode and timeouts |
| `fastapi` (`@spec/fastapi`) | `fastapi({...})`                 | `title`, `version`, `prefix`, `port`, `services: [ref]`, `resources: [ref]`, `requires?` |

Notes:

- `field.ref("User")` serializes with a `target` key:
  `{ "type": "ref", "target": "User" }`.
- `field.enum("pending", "confirmed")` serializes as
  `{ "type": "enum", "states": ["pending", "confirmed"] }`.
- `count(Entity)` produces an `api` node with pinned semantics:
  `{ "method": "GET", "operation": "count", "entity": ref, "path", "auth }`.
- A `fastapi` node serving crud or auth resources carries
  `requires: ["RelationalStore"]` — the link pass resolves it against
  providers exactly like the auth package's own requirement.

## Serialization rules

- JSON, 2-space indent, trailing newline
- All object keys sorted recursively
- `undefined` values and functions are dropped
- No timestamps, no random values, no absolute paths (entry paths are
  project-relative)

Same spec source + package versions + compiler version ⇒ identical bytes.
