# CLI reference

```bash
spec <command> <file.spec.ts> [--debug] [--help]
```

## Commands

### `spec check <file>`

Runs the semantic pipeline (parse, resolve, validate, link) and reports
diagnostics. Writes no artifacts.

| Exit | Meaning           |
| ---- | ----------------- |
| 0    | Valid (warnings allowed) |
| 1    | Invalid (≥1 error diagnostic) |
| 2    | Compiler/usage error |

### `spec build <file>`

Full compile. On success writes to the output directory (default `.spec`,
see `spec.config.ts`):

| File               | Content                                    |
| ------------------ | ------------------------------------------ |
| `spec.ir.json`     | The Spec IR (deterministic, versioned)     |
| `diagnostics.json` | All diagnostics, sorted by source location |
| `manifest.json`    | Spec/compiler/package versions             |

On failure, prints diagnostics and writes nothing.

### `spec inspect <file>`

Prints the human-readable specification tree. Requires a valid
specification (exit 1 otherwise).

## Options

| Option   | Effect                                        |
| -------- | --------------------------------------------- |
| `--debug` | Show internal stack traces on compiler bugs  |
| `--help`  | Print usage                                   |

## Configuration

`spec.config.ts` in the project root:

```ts
export default {
  outputDir: ".spec", // where build artifacts are written
}
```

## Exit codes

| Code | Category              | Typical cause                              |
| ---- | --------------------- | ------------------------------------------ |
| 0    | Success              | —                                          |
| 1    | Specification error  | Diagnostics with level `error`             |
| 2    | Internal / usage     | Unknown command, missing file, compiler bug |
