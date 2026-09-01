# CLI

The `spec` command line tool compiles and inspects specifications.

```bash
spec check <file.spec.ts>     # static semantic check, no artifacts
spec build <file.spec.ts>     # full compile, writes artifacts
spec inspect <file.spec.ts>   # print the specification tree
```

In the repository, run it through pnpm:

```bash
pnpm spec build examples/basic-web-app/app.spec.ts
```

## spec check

Runs parse → resolve → validate → link — the full semantic pipeline, but
writes nothing.

```bash
spec check app.spec.ts
```

Success:

```
✓ Specification valid
```

Failure (exit code 1), with every diagnostic:

```
✗ Specification invalid

AUTH_IDENTITY_NOT_UNIQUE
app.spec.ts:21:15

Authentication identity User.email should be unique.
```

Warnings are printed even on success — they never change the exit code.

## spec build

Runs the complete pipeline and writes artifacts to the output directory
(`.spec` by default):

```
✓ Specification compiled
✓ IR written to .spec/spec.ir.json
```

```
.spec/
├── spec.ir.json      # the Spec IR (deterministic)
├── diagnostics.json  # all diagnostics, even when the build fails
└── manifest.json     # versions for reproducibility
```

If the specification has errors, nothing is written and the diagnostics
are printed instead.

## spec inspect

Prints a human-readable tree of the specification, rendered by the
packages themselves (each package can register an inspector per node
kind):

```
Application ExampleApp

Entities
└── User
    ├── email: email [unique]
    ├── id: uuid
    └── name: string

Services
└── MainAuth
    ├── principal: User
    └── password
        └── identity: User.email

Resources
└── PostgreSQL
    └── entities: User
```

## spec generate

Compiles the specification and then **generates the application** with a
headless coding agent executing a generation DAG (project → models →
schemas/security → routers → app wiring). Each independent generation
(shot) must pass the compiler's own conformance suite **on the first
attempt** and expose the same interface as every other shot —
repeatability is part of the build, not a hope, and there is no repair.
See [agentic generation](./generate) and [the golden rule](./golden-rule).

```
spec generate app.spec.ts --shots 3
```

## Exit codes

| Code | Meaning                                              |
| ---- | ---------------------------------------------------- |
| `0`  | Success                                              |
| `1`  | Specification error (structured diagnostics emitted) |
| `2`  | Compiler / internal error, or usage error            |

This separation is deliberate: `1` means *your spec has a problem an
agent could fix*; `2` means *the tool has a problem a human should look
at*.

## --debug

Compiler bugs raise `InternalCompilerError` and hide their stack traces
by default. Add `--debug` to see them:

```bash
spec build app.spec.ts --debug
```

## Configuration

Place a `spec.config.ts` in your project root:

```ts
export default {
  outputDir: ".spec",
}
```

Currently supported: `outputDir` (default `.spec`). The config file is
read statically — like specifications, it is never executed.
