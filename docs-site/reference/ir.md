# Spec IR format reference

Current version: **`spec-ir/0.1`**

## Top level

```ts
interface SpecIR {
  version: string                  // "spec-ir/0.1"
  app: { name: string }
  packages: PackageReference[]     // sorted by name
  nodes: SpecNode[]                // sorted by id
  capabilities: {
    required: CapabilityRequirement[]  // sorted by capability
    provided: CapabilityProvider[]     // sorted by capability
  }
  diagnostics: Diagnostic[]        // sorted by source location
  metadata: {
    compilerVersion: string
    generatedAt?: string           // omitted in the MVP (determinism)
  }
}
```

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
| `app` (`@spec/core`)        | `defineApp({...})`               | `name`, `entities`, `services`, `resources`   |
| `entity` (`@spec/web`)      | `entity("Name", fields)`         | `fields: { [name]: { type, unique?, target?, ... } }` |
| `crud` (`@spec/web`)        | `crud(Entity, opts?)`            | `entity: ref`, `path`, `methods?`, `auth`     |
| `page` / `api` (`@spec/web`)| `page({...})` / `api({...})`     | `path`, `title` / `method`, `operation`, `input`, `output` |
| `auth` (`@spec/auth`)       | `auth({...})`                    | `principal: ref`, `requires: [...]`           |
| `passwordStrategy` (`@spec/auth`) | `password({...})` child      | `identity: fieldRef`                          |
| `postgres` (`@spec/postgres`) | `postgres({...})`              | `entities: [ref]`, `provides: [...]`          |
| `fastapi` (`@spec/fastapi`) | `fastapi({...})`                 | `title`, `version`, `prefix`, `port`, `services: [ref]`, `resources: [ref]`, `requires?` |

Notes:

- `field.ref("User")` serializes with a `target` key:
  `{ "type": "ref", "target": "User" }`.
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
