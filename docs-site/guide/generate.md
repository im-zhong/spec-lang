# Agentic generation

`spec generate` joins the deterministic compiler with a headless coding agent.
The compiler decides the complete contract, task graph, file ownership,
acceptance commands, and conformance oracle. The agent implements one narrow
DAG node at a time.

Real generation is GitHub-native. Every shot receives a newly created private
GitHub repository and a distinct local clone; generated projects are never
written into the `spec-lang` source repository. See [Git and GitHub
execution](/reference/github-execution) for the complete branch, PR, check,
merge, and resume protocol.

## Prerequisites

- Git and GitHub CLI (`gh`) with permission to create private repositories;
- Docker and access to the digest-pinned generator image;
- a working headless Claude-compatible agent configuration;
- `uv` and the required Python toolchain for local deterministic checks;
- a clean `spec-lang` development checkout for compiler work.

Effort, maximum turns, container digest, and run id are mandatory
for execution because they become immutable plan inputs.

## 1. Write and check the specification

Everything the application may expose belongs in the specification: entities,
routes, authentication, lifecycles, invariants, storage, infrastructure, and
the selected backend target.

The media-platform example combines all major backend features:

```bash
pnpm spec check examples/media-platform/app.spec.ts
```

Invalid specifications stop before repositories are created or agent tokens
are spent.

## 2. Plan without agent spend

```bash
pnpm spec generate examples/media-platform/app.spec.ts --dry-run
```

The dry run compiles the Spec IR and writes deterministic planning artifacts:

| Artifact | Meaning |
| --- | --- |
| `.spec/blueprint.json` | Complete backend behavior contract |
| `.spec/agent.tasks.json` | DAG nodes, edges, scopes, prompt hashes, verification plan |

Run the dry-run twice when changing generation behavior and compare the files
byte for byte. If they differ, do not start real shots.

## 3. Generate independent shots

```bash
pnpm spec generate examples/media-platform/app.spec.ts \
  --run-id media-platform-v1 \
  --image ghcr.io/OWNER/spec-agent@sha256:DIGEST \
  --effort medium \
  --max-turns 100 \
  --target-dir products/media-platform/backend \
  --shots 2 \
  --concurrency 2
```

The generator automatically creates repositories such as:

```text
OWNER/spec-mediaoperationsapi-backend-media-platform-v1-shot-1
OWNER/spec-mediaoperationsapi-backend-media-platform-v1-shot-2
```

The two repositories are the independent experiments required by the golden
rule. The same frozen Spec IR, DAG semantics, oracle, and execution environment
are applied in both.

`--concurrency` is a total budget. With two shots and concurrency two, the two
shots execute in parallel while each shot runs one node at a time. Increasing
the budget can also run independent nodes within each shot concurrently.

## 4. Follow progress on GitHub

Each DAG node produces a branch, immutable integration base, commit, PR, and
required `spec-generation` check. A child begins only after every dependency
has a successful checked head SHA.

Intermediate PRs do not need to merge into `main`. The generator combines
checked dependency commits into the child's integration base, so downstream
nodes see exactly their declared dependency closure. Multiple ready branches
are joined deterministically; overlapping unordered file ownership is rejected
before execution and Git merge conflicts fail the shot.

A large DAG therefore creates many open PRs. This is expected: PRs are durable
task evidence, not a queue of changes that must all be merged manually.

```bash
gh pr list --repo OWNER/SHOT_REPOSITORY --state all \
  --json number,title,state,headRefName,headRefOid,statusCheckRollup
```

## 5. Read the result

Each shot writes immutable-plan and result metadata under:

```text
.spec/generation/<run-id>-shot-1/plan.json
.spec/generation/<run-id>-shot-1/result.json
.spec/generation/<run-id>-shot-2/plan.json
.spec/generation/<run-id>-shot-2/result.json
```

The report records every task's branch, integration-base SHA, pushed head SHA,
PR, checks, timing, cost, diagnostics, skipped nodes, and scheduler failures.
The final generated source and evidence live in the shot repository's durable
sink commit.

For a backend, the compiler-owned conformance node installs the generated
project and runs the complete oracle once. It also emits declared cross-shot
evidence, normally:

```text
conformance-output/openapi.json
conformance-output/behavior.json
```

The generator reads those files from each exact sink commit and compares their
hashes across repositories.

## What counts as success

A multi-shot run succeeds only when all three golden-rule requirements hold:

1. **Conformance** — every shot passes the compiler-owned suite on its first
   judgment; there is no repair loop.
2. **Equality** — compiler-owned OpenAPI and behavior evidence is byte-identical
   across independent shot repositories.
3. **Correctness** — the oracle proves every declared route, state transition,
   invariant, infrastructure contract, and navigation target. Identical but
   wrong output is still a specification defect.

The coding agent never grades itself. GitHub checks and compiler materialized
tests are authoritative.

## Resume an interrupted run

Use the exact original command with `--resume`:

```bash
pnpm spec generate examples/media-platform/app.spec.ts \
  --run-id media-platform-v1 \
  --image ghcr.io/OWNER/spec-agent@sha256:DIGEST \
  --effort medium --max-turns 100 \
  --target-dir products/media-platform/backend \
  --shots 2 --concurrency 2 \
  --resume
```

Resume reconstructs progress from immutable plan refs, remote task branches,
commit trailers, PR head SHAs, and required checks. Local worktrees, containers,
and agent sessions may disappear without losing checked work. Changed plan or
runtime settings, moved branches, or mismatched provenance are rejected.

Resume is for control-plane interruption. It is not a repair mechanism for a
nonconformant generated application.

## When a run fails

Never edit generated code to make a failed shot pass. Preserve its repository
and evidence, diagnose the missing contract, and fix in this order:

1. specification vocabulary and validators;
2. compiler lowering, blueprint, prompts, runtime contract, or conformance
   oracle;
3. the example specification;
4. execution harness infrastructure, only when the defect is infrastructural.

Then rerun deterministic tests and dry-run stability before generating every
shot again with a new run id and fresh repositories. Record the defect and run
outcome in `docs/golden-rule-results.md`.

## CLI options

| Flag | Meaning | Default |
| --- | --- | --- |
| `--dry-run` | Compile and write planning artifacts only | — |
| `--shots <n>` | Number of independent repositories/generations | `3` |
| `--run-id <id>` | Stable run identity | required for execution |
| `--image <repo@sha256:...>` | Immutable agent/container environment | required for execution |
| `--model <id>` | Optional coding-agent model override | Claude CLI selection |
| `--effort <level>` | Pinned `low\|medium\|high\|xhigh\|max` effort | required for execution |
| `--max-turns <n>` | Pinned task turn limit | required for execution |
| `--target-dir <dir>` | Product path inside each shot repository | derived from app and target |
| `--repository <owner/base>` | Per-shot repository prefix | authenticated owner + app/target |
| `--concurrency <n>` | Total parallel node budget | `2` |
| `--check <name>` | Required GitHub check | `spec-generation` |
| `--resume` | Reconstruct the same immutable run | — |

There is deliberately no repair flag.

## Next references

- [The golden rule](/guide/golden-rule) explains why conformance, equality, and
  correctness are separate requirements.
- [Generation internals](/reference/generation) describes compiler lowering,
  task construction, the oracle, and equality evidence.
- [Git and GitHub execution](/reference/github-execution) specifies every
  repository, ref, worktree, commit, PR, check, merge, and recovery step.
