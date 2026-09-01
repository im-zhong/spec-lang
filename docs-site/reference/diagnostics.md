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
| `LIFECYCLE_TARGET_INVALID`  | error  | `lifecycle(...)` target is not an entity            |
| `LIFECYCLE_ENTITY_NOT_FOUND`| error  | Lifecycle entity is absent from the IR              |
| `LIFECYCLE_FIELD_INVALID`   | error  | State field is not an enum on the target entity     |
| `LIFECYCLE_INITIAL_NOT_STATE` | error | Initial state is outside the enum                   |
| `LIFECYCLE_NO_TRANSITIONS`  | error  | Lifecycle declares no transitions                   |
| `LIFECYCLE_TRANSITION_TARGET_UNKNOWN` | error | Transition state is outside the enum       |
| `LIFECYCLE_TRANSITION_DUPLICATE` | error | Event/from transition is duplicated             |
| `LIFECYCLE_STATE_UNREACHABLE` | error | An enum state cannot be reached from the initial state |
| `LIFECYCLE_GUARD_TERM_UNKNOWN` | error | Guard references an unsupported term             |
| `LIFECYCLE_GUARD_SHAPE_UNSUPPORTED` | error | Guard expression cannot be lowered            |
| `LIFECYCLE_EFFECTS_INVALID` | error  | Transition effects value is not an array            |
| `LIFECYCLE_FIELD_IMMUTABLE` | error  | A `set` effect tries to change the lifecycle field  |
| `EFFECT_KIND_UNKNOWN`       | error  | Effect is neither `set` nor `emit`                  |
| `EFFECT_TARGET_UNKNOWN`     | error  | `set` targets an unknown entity field               |
| `EFFECT_PAYLOAD_FIELD_UNKNOWN` | error | `emit` payload names an unknown entity field     |
| `EFFECT_VALUE_UNSUPPORTED`  | error  | `set` value cannot be statically lowered            |
| `EFFECT_VALUE_TYPE_MISMATCH`| error  | `set` value is incompatible with the target field   |
| `INVARIANT_TARGET_INVALID`  | error  | `invariant({ on })` does not target an entity       |
| `INVARIANT_ENTITY_NOT_FOUND`| error  | Invariant entity is absent from the IR              |
| `INVARIANT_CHECK_INVALID`   | error  | Invariant has no valid check expression             |
| `INVARIANT_TERM_UNKNOWN`    | error  | Invariant references an unsupported term            |
| `INVARIANT_SHAPE_UNSUPPORTED` | error | Invariant is outside row-check/cross-row-count lowering |

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
| `AGENT_TASK_FAILED`         | error   | A DAG generation task's agent run failed          |
| `GENERATION_NONCONFORMANT`  | error   | A shot failed its FIRST verification — a specification/blueprint defect; pin the contract and regenerate (there is no repair) |
| `SCOPE_VIOLATION`           | warning | A task modified files outside its declared scope  |
| `AGENT_VERIFIED`            | info    | A shot passed conformance on the first attempt    |
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
