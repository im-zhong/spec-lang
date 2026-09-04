# CLI reference

```bash
spec <command> <file.spec.ts> [options]
```

## Commands

### `spec check <file>`

Runs the complete static pipeline and reports diagnostics without writing
artifacts.

### `spec build <file>`

Compiles a valid specification and writes deterministic compiler artifacts to
the configured output directory (default `.spec/`):

| File | Content |
| --- | --- |
| `spec.ir.json` | Versioned Spec IR |
| `diagnostics.json` | Stably sorted diagnostics |
| `manifest.json` | Spec, compiler, and package versions |

### `spec inspect <file>`

Prints the human-readable specification tree. The specification must be valid.

### `spec generate <file>`

Compiles a backend target, creates one private temporary GitHub repository per
shot, and executes the compiler-owned generation DAG through isolated
containers, branches, PRs, and required checks. Every shot receives one
compiler-owned conformance judgment; multiple shots are compared using declared
OpenAPI and behavior evidence.

See [Agentic generation](/guide/generate) and [Git and GitHub
execution](/reference/github-execution).

### `spec generate-frontend <file>`

Runs the same GitHub-native shot protocol for a React target. The
compiler-owned Playwright oracle checks layout, behavior, and navigation and
emits the declared visual/JSON equality evidence.

## Generation options

| Option | Effect | Default |
| --- | --- | --- |
| `--dry-run` | Write blueprint/DAG planning artifacts; create no repositories and run no agent | — |
| `--shots <n>` | Independent generations, each in a distinct remote repository and local root | `3` |
| `--run-id <id>` | Stable GitHub run identity | required for execution |
| `--image <repo@sha256:...>` | Digest-pinned generator image | required for execution |
| `--model <id>` | Optional coding-agent model override | Claude CLI selection |
| `--effort <level>` | Pinned `low\|medium\|high\|xhigh\|max` effort | required for execution |
| `--max-turns <n>` | Pinned maximum turns per agent node | required for execution |
| `--target-dir <dir>` | Repository-relative product directory in every shot | `products/<app>/<target>` |
| `--repository <owner/base>` | Temporary repository owner/name prefix; run and shot suffixes are automatic | authenticated owner + app/target |
| `--concurrency <n>` | Total maximum parallel generator nodes across shots | `2` |
| `--check <name>` | Required GitHub check | `spec-generation` |
| `--execution <mode>` | Durable-branch control plane: `github` (real PRs/checks) or `local` (per-shot bare Git remote on this machine; fast iteration, not golden-rule evidence) | `github` |
| `--runtime <mode>` | Where the agent and acceptance commands execute: `docker` (pinned image) or `host` (directly in the shot worktree; the host must provide the toolchain) | `docker` |
| `--merge-policy <policy>` | How internally checked task heads land: `merge-to-main` (deterministic code merge per feature node), `pull-request`, or `merge-queue` | `merge-to-main` |
| `--resume` | Reconstruct the same immutable run from GitHub state | — |
| `--debug` | Show internal stack traces | — |
| `--help` | Print usage | — |

`--run-id`, `--image`, `--model`, `--effort`, and `--max-turns` are mandatory
for real generation because they are frozen into the immutable execution plan.
The runtime must match the plan exactly.

The temporary repository workflow currently exposes the compiler-owned check
name `spec-generation`; supplying another check name is rejected.

### Fast iteration: `--execution local --runtime host`

The two environment axes are independent, so the fastest iteration loop is:

```sh
spec generate app.spec.ts --run-id fast-1 --image <digest> \
  --effort low --max-turns 40 --shots 1 \
  --execution local --runtime host --merge-policy merge-to-main
```

Each shot gets a bare Git remote plus clone under
`.spec/generation/<run-id>/repositories/`, agent and acceptance commands run
directly on the host in per-task worktrees, and each feature-node branch is
verified against its pushed head in a fresh detached worktree (the local
equivalent of the GitHub check) before deterministic code merges it into
`main`. There are no `gh` calls, no container boots, and no CI round trips.
Local runs exercise the identical orchestration path but are **not**
golden-rule evidence; the golden rule still requires GitHub repository
isolation. `--execution local` requires `--merge-policy merge-to-main` because
merged `main` is the only durable landing evidence without pull requests.

There is no `--out` generation mode and no repair option. Generated projects
live in their per-shot GitHub repositories, not under `out/` in the compiler
repository. Local `.spec/generation/` contains clones, disposable worktrees,
immutable plan copies, and result reports.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command succeeded; for multi-shot generation, every shot conformed and declared evidence matched |
| `1` | Invalid specification, failed shot/check/conformance, or divergent evidence |
| `2` | Usage or compiler error |

Some infrastructure failures in GitHub-native execution are thrown as command
errors and therefore surface through the usage/compiler-error path. Inspect the
per-shot result when present and preserve failed repositories for diagnosis.

## Configuration

`spec.config.ts` controls deterministic compiler artifact output:

```ts
export default {
  outputDir: ".spec",
}
```

It does not redirect real generated products into the `spec-lang` checkout.
