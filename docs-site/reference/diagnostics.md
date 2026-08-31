# Diagnostic codes reference

Every diagnostic carries a stable `code`. Codes are grouped by owner: the
compiler core emits structural codes; each package owns its domain codes.

## Compiler core

### Syntax & restrictions

| Code                       | Level  | Meaning                                                       |
| -------------------------- | ------ | ------------------------------------------------------------- |
| `SPEC_SYNTAX_ERROR`        | error  | The file is not valid TypeScript                               |
| `SPEC_UNSUPPORTED_SYNTAX`  | error  | Construct outside the allowed subset (loops, functions, `let`, …) |
| `SPEC_FORBIDDEN_IMPORT`    | error  | Import of a filesystem/network module (`fs`, `http`, …)       |
| `SPEC_FORBIDDEN_CALL`      | error  | `eval()` / `Function()` call                                  |
| `SPEC_FORBIDDEN_ACCESS`    | error  | `process.env`, `Date.now`, `Math.random`, …                   |
| `SPEC_DUPLICATE_KEY`       | error  | Duplicate key in an object literal                            |

### Name & call resolution

| Code                       | Level  | Meaning                                                       |
| -------------------------- | ------ | ------------------------------------------------------------- |
| `SPEC_UNKNOWN_IDENTIFIER`  | error  | Identifier is neither a local const nor a package import       |
| `SPEC_UNKNOWN_PROPERTY`    | error  | Property does not exist on the evaluated value                 |
| `SPEC_UNKNOWN_IMPORT`      | error  | Imported name is not exported by the package                   |
| `SPEC_NOT_CALLABLE`        | error  | Call target is not a function                                  |
| `SPEC_BUILDER_FAILED`      | error  | A trusted package builder threw (usually bad arguments)        |

### Packages & structure

| Code                        | Level  | Meaning                                                      |
| --------------------------- | ------ | ------------------------------------------------------------ |
| `SPEC_PACKAGE_LOAD_FAILED`  | error  | Package could not be loaded / is not a spec package          |
| `SPEC_ENTRY_NOT_FOUND`      | error  | The `.spec.ts` file does not exist                           |
| `SPEC_NO_APP`               | error  | Missing `export default defineApp({...})`                    |
| `NODE_ID_COLLISION`         | error  | Two nodes derived the same id (duplicate names)              |

### Capabilities (link pass)

| Code                            | Level   | Meaning                                         |
| ------------------------------- | ------- | ----------------------------------------------- |
| `MISSING_CAPABILITY_PROVIDER`   | error   | A required capability has no provider           |
| `DUPLICATE_CAPABILITY_PROVIDER` | warning | A capability is provided by multiple nodes      |

## @spec/web

| Code                        | Level  | Meaning                                            |
| --------------------------- | ------ | -------------------------------------------------- |
| `DUPLICATE_ENTITY_NAME`     | error  | Two entities share a name                          |
| `DUPLICATE_FIELD_NAME`      | error  | Two fields share a name within an entity           |
| `INVALID_FIELD_DEFINITION`  | error  | Field is not built with `field.*()`                |
| `FIELD_TYPE_UNKNOWN`        | error  | Field type not in the supported set                |
| `FIELD_REF_TARGET_INVALID`  | error  | `ref` field has no target (`field.ref("X")`)       |
| `FIELD_REF_TARGET_UNKNOWN`  | error  | `ref` field points at an unknown entity            |
| `CRUD_TARGET_INVALID`       | error  | `crud(...)` target is not an entity builder        |
| `CRUD_ENTITY_NOT_FOUND`     | error  | `crud(...)` references an undefined entity         |
| `CRUD_INVALID_PATH`         | error  | CRUD path is not an absolute URL path              |
| `CRUD_DUPLICATE_PATH`       | error  | Two CRUD resources share a path                    |
| `CRUD_METHOD_UNKNOWN`       | error  | Method outside `list/get/create/update/delete`     |
| `CRUD_METHOD_DUPLICATE`     | error  | Duplicate method in `crud(..., { methods })`       |
| `CRUD_METHODS_INVALID`      | error  | `methods` is not an array                          |
| `CRUD_NAME_MISMATCH`        | warning | CRUD node name differs from its entity name       |
| `API_TARGET_INVALID`        | error  | `count(...)` target is not an entity builder       |
| `API_ENTITY_NOT_FOUND`      | error  | `count(...)` references an undefined entity        |
| `API_INVALID_PATH`          | error  | `count(...)` path is invalid                       |

## @spec/fastapi

| Code                            | Level   | Meaning                                            |
| ------------------------------- | ------- | -------------------------------------------------- |
| `FASTAPI_NO_SERVICES`           | warning | Server exposes no services                         |
| `FASTAPI_SERVICE_INVALID`       | error   | Service entry is not a node reference              |
| `FASTAPI_SERVICE_NOT_FOUND`     | error   | Referenced service node does not exist             |
| `FASTAPI_SERVICE_KIND_UNSUPPORTED` | error | Server cannot serve this node kind                |
| `FASTAPI_RESOURCE_INVALID`      | error   | Resource entry is not a node reference             |
| `FASTAPI_RESOURCE_NOT_FOUND`    | error   | Referenced resource node does not exist            |
| `FASTAPI_API_OPERATION_UNSUPPORTED` | error | Generic `api()` node has no pinned operation      |
| `FASTAPI_PRINCIPAL_REF_UNSUPPORTED` | error | Auth principal must not have `ref` fields         |
| `FASTAPI_NODE_NOT_SERVED`       | warning | crud/auth node not served by any server            |

## @spec/agent (generation)

| Code                        | Level   | Meaning                                           |
| --------------------------- | ------- | ------------------------------------------------- |
| `AGENT_TASK_FAILED`         | error   | The coding agent run failed                       |
| `AGENT_VERIFICATION_FAILED` | error   | A shot failed the compiler's verification plan    |
| `AGENT_VERIFIED`            | info    | A shot passed conformance verification            |
| `AGENT_REPAIRED`            | info    | A shot was repaired after verification failure    |
| `REPEATABLE`                | info    | All shots passed the same conformance suite       |
| `INTERFACE_IDENTICAL`       | info    | Shots expose an identical OpenAPI interface       |
| `INTERFACE_DIVERGENT`       | error   | Shots diverge — the golden rule is violated       |
| `OPENAPI_SNAPSHOT_FAILED`   | warning | Could not capture a shot's OpenAPI interface      |

## @spec/auth

| Code                            | Level   | Meaning                                            |
| ------------------------------- | ------- | -------------------------------------------------- |
| `AUTH_PRINCIPAL_INVALID`        | error   | Principal is not a node reference                  |
| `AUTH_PRINCIPAL_NOT_ENTITY`     | error   | Principal does not resolve to an entity            |
| `AUTH_IDENTITY_INVALID`         | error   | Strategy identity is not a field reference         |
| `AUTH_IDENTITY_NOT_IN_PRINCIPAL`| error   | Identity field belongs to a different entity       |
| `AUTH_IDENTITY_NOT_UNIQUE`      | warning | Identity field lacks `.unique()`                   |

## Shape

```ts
interface Diagnostic {
  code: string
  level: "error" | "warning" | "info"
  message: string
  source?: { file: string; line: number; column: number }
  nodeId?: string
  details?: Record<string, unknown>
}
```

Diagnostics are sorted by `(file, line, column, code)` — the report is as
deterministic as the IR itself.
