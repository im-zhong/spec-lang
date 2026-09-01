# CLI reference

```bash
spec <command> <file.spec.ts> [--debug] [--help]
```

## Commands

### `spec check <file>`

Runs the semantic pipeline (parse, resolve, normalize, validate, link,
lower) and reports diagnostics. Writes no artifacts. `lower` is currently
a no-op extension point.

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

### `spec generate <file>`

Compiles, lowers to a backend blueprint, and generates the application
with a headless coding agent — N independent shots, each judged by the
compiler's runtime functional conformance suite and compared for
normalized OpenAPI equality (see
[agentic generation](/guide/generate)). Requires `claude` on `PATH`, plus
`uv` and Python 3.10+ for verification.

| Exit | Meaning                                            |
| ---- | -------------------------------------------------- |
| 0    | All shots conformant and interface-identical       |
| 1    | Invalid spec, a shot failed, or shots diverged     |
| 2    | Compiler/usage error                               |

Artifacts written to the output dir: `blueprint.json`,
`agent.tasks.json`, `agent.result.json`; generated apps in `out/`.

## Options

| Option   | Effect                                        |
| -------- | --------------------------------------------- |
| `--debug` | Show internal stack traces on compiler bugs  |
| `--help`  | Print usage                                   |

### `generate` options

| Option                 | Effect                                        | Default |
| ---------------------- | --------------------------------------------- | ------- |
| `--shots <n>`          | Independent generations per spec              | `3`     |
| `--dry-run`            | Plan only (blueprint + DAG), no agent         | —       |
| `--out <dir>`          | Generated-app root                            | `out/`  |
| `--model <id>`         | Agent model                                   | `SPEC_AGENT_MODEL` or `glm-5.3-flash` |
| `--max-turns <n>`      | Agent turn budget per DAG task                | `60`    |

There is deliberately no repair option: a shot that fails its first
verification is a specification defect (pin the contract, regenerate).

The CLI resolves `--model` from the explicit option, then
`SPEC_AGENT_MODEL`, then `glm-5.3-flash`, and passes that value to the
agent runner. At the lower-level runner API, `--model` is omitted when no
model is supplied, so Claude Code's own settings can select the model.

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
