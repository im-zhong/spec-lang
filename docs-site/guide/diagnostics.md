# Diagnostics

Diagnostics are the compiler's universal feedback channel — for humans
today, for agents tomorrow. Every problem, from a syntax error to a
cross-package capability mismatch, is a structured record:

```ts
interface Diagnostic {
  code: string                 // stable machine-readable identifier
  level: "error" | "warning" | "info"
  message: string              // human-readable explanation
  source?: SourceLocation      // file, line, column
  nodeId?: string              // the offending spec node, if known
  details?: Record<string, unknown>  // structured context
}
```

Example:

```json
{
  "code": "AUTH_IDENTITY_NOT_UNIQUE",
  "level": "warning",
  "message": "Authentication identity User.email should be unique.",
  "source": { "file": "app.spec.ts", "line": 21, "column": 15 },
  "details": { "identity": "User.email" }
}
```

## Levels

| Level      | Effect on `spec check` / `spec build`   |
| ---------- | --------------------------------------- |
| `error`    | Exit code 1; build writes no artifacts |
| `warning`  | Printed, compilation succeeds          |
| `info`     | Printed; used by generation (`AGENT_VERIFIED`, `REPEATABLE`, `INTERFACE_IDENTICAL`, …) |

## Ordering and determinism

Diagnostics are sorted by `(file, line, column, code)` before being
reported or written to `diagnostics.json`, so the same spec always
produces the same report — just like the IR itself.

## Reading a diagnostic

```
AUTH_IDENTITY_NOT_IN_PRINCIPAL          ← code (stable, searchable)
tests/fixtures/invalid-auth-identity/app.spec.ts:21:13   ← source location

Auth identity Product.id does not belong to principal entity "User".   ← message
```

The `code` is the contract: it stays stable even if messages are
reworded. `details` carries the structured payload an agent needs to
reason about a repair without parsing English.

## The agent-repair loop (live today)

```
Compiler → Diagnostic → Agent → Repair
```

The loop runs in two places now. During **generation**
([`spec generate`](/guide/generate)), failed verification output is fed
back to the coding agent as a repair prompt — with structured
`AGENT_VERIFICATION_FAILED` diagnostics recording exactly which step
failed and its output tail. And because diagnostics are code-addressed,
source-located and carry details, spec *repair* by agents follows the
same protocol: consume `diagnostics.json`, rewrite the spec, recompile,
check that the code disappeared.

## Full code reference

See the [diagnostic codes reference](/reference/diagnostics) for every
code emitted by the compiler core and the built-in packages.
