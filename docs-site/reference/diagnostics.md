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
