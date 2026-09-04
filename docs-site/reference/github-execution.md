# Git and GitHub execution

`spec generate` and `spec generate-frontend` execute the compiler-owned
generation DAG through Git and GitHub. GitHub is not merely a place to publish
the final result: remote repositories, immutable refs, task branches, pull
requests, and checks are the durable state of a run.

This page describes the current implementation. It is deliberately explicit
about what is durable, how unmerged work reaches downstream tasks, how
parallel branches are joined, what can be resumed, and why a run creates many
open pull requests.

## Non-negotiable invariants

A non-dry-run generation obeys these rules:

- every shot has its own private temporary GitHub repository;
- every shot has its own local clone and worktree root;
- the source `spec-lang` repository is never a generation target;
- the Spec IR, generation plan, conformance oracle, agent settings, container
  image, and toolchain hashes are frozen before agent execution;
- a child consumes only checked, pushed dependency commit SHAs;
- every task owns an exact set of repository-relative paths;
- compiler conformance runs once, with no generated-code repair;
- failed repositories and their GitHub evidence are preserved for diagnosis.

Two branches or directories in one repository do not count as two independent
shots.

## Control-plane topology

For two shots, the generator creates this topology:

```text
spec-lang source checkout
  |
  | compile the same spec and freeze the same inputs
  |
  +--> temporary GitHub repository for shot-1
  |      +-- one local clone
  |      +-- immutable plan and integration-base refs
  |      +-- one branch, commit, PR, and check per DAG node
  |
  +--> temporary GitHub repository for shot-2
         +-- a different local clone
         +-- independent refs, commits, PRs, and checks
```

The default repository name is derived from the authenticated GitHub owner,
application, target, run id, and shot id. For example:

```text
OWNER/spec-mediaoperationsapi-backend-media-platform-v1-shot-1
OWNER/spec-mediaoperationsapi-backend-media-platform-v1-shot-2
```

The paired clones live under:

```text
.spec/generation/<run-id>/repositories/shot-1
.spec/generation/<run-id>/repositories/shot-2
```

These paths are generator state, not generated products inside the
`spec-lang` repository.

## Command and frozen inputs

Plan locally before spending agent tokens:

```bash
pnpm spec check examples/media-platform/app.spec.ts
pnpm spec generate examples/media-platform/app.spec.ts --dry-run
```

A real backend run requires an explicit run id, digest-pinned image, effort,
and turn budget. Omit `--model` to use Claude CLI's default selection:

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

The immutable plan records:

- root commit SHA and target repository;
- complete task graph, prompts, exact scopes, and acceptance commands;
- required GitHub check names;
- digest-pinned execution image;
- devcontainer and toolchain-lock hashes;
- the presence or absence of a model override, effort, maximum turns, and per-shot concurrency;
- merge policy and compiler-owned materializations.

Runtime settings must equal the values in the plan. A resume cannot silently
change them.

## Repository creation and bootstrap

Before a shot begins, the generator:

1. resolves an owner and repository-name prefix;
2. refuses to overwrite an existing repository unless `--resume` was given;
3. creates a private repository through `gh repo create`;
4. clones it into the shot's distinct local root through GitHub's SSH endpoint
   on port 443, preserving SSH-key workflow-write permission without depending
   on outbound port 22;
5. commits the compiler-owned `.github/workflows/spec-generation.yml`;
6. pushes that bootstrap commit to the default branch;
7. verifies that the exact bootstrap SHA is visible on the remote;
8. uses that SHA as the shot's `rootBaseSha`.

The workflow is created by the generator rather than the coding agent. It
reads acceptance commands from the immutable plan and runs them in the same
digest-pinned image used by the plan.

If repository creation, cloning, bootstrap publication, or topology validation
fails, generation stops. It never falls back to the current repository or to
several local output directories.

On resume, the generator first verifies that an existing clone points to the
expected `owner/name`, then normalizes its `origin` to the same SSH-over-443
transport before any fetch, push, or `ls-remote` operation. Git runs in batch
mode and accepts only a previously known or first-seen host key, never a
changed key.

## Durable refs and branches

For run `R` and task `T`, the remote contains:

| Purpose | Ref or branch |
| --- | --- |
| Canonical plan | `spec/generate/R/plan` |
| Task integration base | `spec/generate/R/bases/T` |
| Task result | `spec/generate/R/T` |

The plan ref contains canonical `plan.json` in a synthetic commit. Plan and
base refs are immutable: publishing the same SHA is idempotent, but finding a
different SHA at an existing ref is a hard failure.

Synthetic plan and integration commits use fixed author, committer, and time
metadata. Combined with stable parent ordering, this makes their SHAs
deterministic for the same inputs.

## Scheduling and concurrency

Only tasks whose dependencies have successful durable results are ready. Ready
tasks are selected in stable task-id order and may execute concurrently up to
the per-shot limit.

Total concurrency is divided across shots:

```text
parallel shots       = min(shots, concurrency)
per-shot concurrency = max(1, floor(concurrency / parallel shots))
```

With `--shots 2 --concurrency 2`, both shots run at the same time and each shot
runs one DAG node at a time. A larger total concurrency can also allow
independent nodes inside a shot to run concurrently.

After the first unsuccessful task, fail-fast scheduling stops launching new
work. Already-running siblings are allowed to finish safely; descendants of a
failed or skipped task never start.

## One task, end to end

For each ready task, the orchestrator performs the following transaction:

1. Verify every dependency branch still points to its recorded checked head
   SHA.
2. Fetch every dependency into a branch-specific scratch ref without changing
   the repository-wide `FETCH_HEAD`.
3. Build and publish the task's immutable integration base.
4. Check whether the task branch already exists and, on resume, validate its
   provenance.
5. Create a detached disposable Git worktree from the integration-base SHA (or
   the existing task head for a retry checkpoint).
6. Start a fresh read-only container from the plan's digest-pinned image. Only
   `/tmp`, `/home/node`, and the mounted worktree are writable.
7. For an agent node, send the frozen prompt to a headless safe-mode agent. For
   a compiler node, materialize compiler-owned files exactly without exposing
   agent credentials.
8. Run the task's container acceptance commands.
9. Audit every changed path against the task's exact scope and run
   `git diff --check`.
10. Commit with immutable provenance trailers and push the task branch without
    force-overwriting divergent history.
11. Create or recover the task PR and wait for required checks against the
    exact expected head SHA.
12. Remove the container and local task worktree. The pushed branch, commit,
    PR, check, and plan remain durable.

Task commits contain trailers such as:

```text
Spec-Run: media-platform-v1-shot-1
Spec-Task: router-Asset
Spec-Fingerprint: sha256:...
Depends-On-Sha: models=<full SHA>
Depends-On-Sha: schemas=<full SHA>
```

On resume, provenance validation proves that the expected integration base is
an ancestor, the trailers match the immutable plan, the remote head has not
moved, and every changed file is in scope.

## How downstream tasks see unmerged code

A downstream task does **not** read `main`, another worktree, an agent session,
or a local patch. It starts from an integration commit containing the checked
heads of all direct dependencies. Because each dependency head already
contains its own ancestors, this also carries the transitive dependency
closure.

```text
models -------- commit A -- checked --+
schemas ------- commit B -- checked --+--> bases/router-Asset
database ------ commit C -- checked --+         |
security ------ commit D -- checked --+         +--> router-Asset task
```

The pull requests may remain open. Git commits are addressable and fetchable
without being merged into `main`, so PR state does not prevent downstream
consumption. A missing dependency edge is therefore a compiler/DAG defect: the
child sees exactly its declared dependency closure, not every task that
happened to run earlier.

Under the `merge-to-main` policy (the CLI default) the model is the team
model instead: `main` is the single integration line. A task's integration
base is **the main commit at which its dependency closure completed** — the
landing commit of the last of its declared dependencies — never simply the
main head at start time. Every sibling of a dependency therefore branches
from the exact same commit regardless of when the scheduler releases it, and
a sibling's code can never leak into another branch through scheduling. The
DAG therefore literally becomes the branch history:

```text
main: base ── merge A ── merge B ── merge C ── merge D
                └─ A ─┘   └─ B ─┘    └─ C ─┘     └─ D ─┘
                          (B and C both branched from the merge-A commit)
```

Landing commits are mechanically locatable — each checked head lands through
exactly one two-parent integration commit whose second parent is that task
head — so the repository walks `main`'s first-parent chain, finds each
dependency's landing, bases the task on the newest one, and proves every
dependency head is an ancestor of that base before the task starts. If
sibling landings swap order between two runs (scheduling), a child's base
commit SHA differs but its tree content is identical, because scopes are
disjoint; the scheduler releases a child only after all of its dependencies
returned, and each dependency returns only after its own deterministic merge
landed on `main`.

## How parallel results are joined

Independent tasks have separate branches, containers, worktrees, and exact
file scopes. Two unordered tasks are rejected before execution if their scopes
contain the same path (`AGENT_EXECUTION_SCOPE_OVERLAP_UNORDERED`). If both must
edit a file, the plan must add an ordering edge or split ownership. The same
scope partition is what guarantees conflict-free `merge-to-main` integrations.

Under the `pull-request` and `merge-queue` policies, when a child has several
parents, the generator:

1. sorts parents by task id;
2. starts from the first checked head;
3. combines each remaining head with `git merge-tree --write-tree`;
4. creates a deterministic multi-parent commit with `git commit-tree`;
5. publishes it as the child's immutable base ref.

There is no agent-driven conflict resolution. A Git conflict stops the child
before it runs and fails the shot. Semantic incompatibility between files can
still merge cleanly; task checks or compiler conformance must detect it.

The golden-rule response to either kind of conflict is to fix scope ownership,
DAG edges, specification vocabulary, lowering, or the compiler oracle and then
regenerate every shot from fresh repositories. Generated code is never patched
to make a shot pass.

## Pull request model

Every DAG node publishes one PR because the PR is the durable unit that binds a
head SHA to GitHub checks and human-auditable metadata.

- A non-sink task PR targets its own integration-base branch.
- The final sink PR targets the repository's default branch.
- The PR body records run id, task id, plan fingerprint, image, integration
  base, dependency SHAs, and owned paths.
- A child is released only after all required checks on its parents report
  success for the exact expected head SHA.

Consequently, a 22-node plan creates approximately 22 PRs per shot, or 44 PRs
for two shots. Intermediate PRs intentionally stay open during and after a run:
their commits are consumed through immutable SHAs, not by merging them into
`main`.

The default merge policy is `pull-request`, so even the successful final PR is
left for review. The execution layer also supports `merge-queue`; with that
policy, only a successful sink PR is submitted with GitHub auto-merge.

The third policy, `merge-to-main`, is the CLI default and works like a
development team: every feature-node branch runs its own acceptance (in the
executor, then again on the pushed head), and once every required check is
green, deterministic code — not a human — merges the head into the default
branch with a two-parent `merge-tree`/`commit-tree` commit whose trailers
record run, task, and plan fingerprint. Merges are serialized per process, so
`main` receives one linear integration history in dependency order. The
compiler's scope partition is the guarantee that these merges never conflict;
a `merge-tree` conflict fails loud as a contract defect. Re-merging an already
landed head is idempotent (ancestor check), which is what makes resume safe.

## Execution environments

The two environment axes are chosen independently; the interfaces
(`AgentExecutionContainerPort`, `AgentExecutionControlPlanePort`,
`AgentExecutionRepositoryPort`) accept any combination:

| Axis | Choices | Meaning |
| --- | --- | --- |
| Runtime | `docker` (default), `host` | Where the agent, loop oracle commands, and acceptance commands execute. `docker` uses the digest-pinned image; `host` runs them directly in the task worktree and assumes the host provides the toolchain. |
| Control plane | `github` (default), `local` | How durable branches are verified and landed. `github` uses real PRs and the `spec-generation` Actions check; `local` uses a per-shot bare Git remote, synthetic PR records, and replays each task's frozen acceptance in a fresh detached worktree of the pushed head. |

`--execution local` implies `--merge-policy merge-to-main` (without pull
requests, merged `main` is the only durable landing evidence) and skips all
`gh` interaction. Local runs are for fast iteration; golden-rule judgment
still requires GitHub repository isolation per shot.

There is currently no automatic post-success operation that closes all
intermediate PRs or deletes temporary repositories. Failed repositories must
be retained long enough to diagnose the only failure evidence. Cleanup is an
explicit lifecycle action, separate from generation.

## GitHub check trust boundary

Every temporary repository receives one compiler-owned required check named
`spec-generation`. On a PR event, the workflow:

1. derives run and task ids from the head branch;
2. fetches `spec/generate/R/plan`;
3. reads that task's acceptance commands and working directory from
   `plan.json`;
4. reads the digest-pinned image from the same plan;
5. pulls the image and runs the commands against the checked-out PR head.

The local orchestrator separately confirms that GitHub is reporting checks for
the expected `headRefOid`; a green check for an older commit is not accepted.
Check polling has a bounded timeout.

Agent credentials are mounted or forwarded only to agent tasks. Compiler
materialization and GitHub Actions acceptance do not receive the host agent's
credential files.

## Compiler nodes and final evidence

After all generated-code sinks pass, the plan adds compiler-owned nodes:

```text
generation sinks --> conformance --> optional container materialization
```

The `conformance` node writes the oracle files, creates a clean environment,
installs the generated project, checks imports, runs the complete conformance
suite once, and produces declared evidence such as:

```text
conformance-output/openapi.json
conformance-output/behavior.json
```

If container contracts exist, a final materialization node writes their
compiler-owned files and validates the generated verifier programs. The last
node is the shot's durable sink commit.

For multiple shots, equality is computed from the declared evidence files in
each independent sink commit. Each file is read with `git show` at the exact
sink SHA and hashed. All shots must first pass conformance, and all hashes must
match. Identical output alone is not correctness; the conformance oracle must
also prove every declared behavior.

## Resume and crash recovery

Resume the same immutable run with exactly the same arguments plus `--resume`:

```bash
pnpm spec generate examples/media-platform/app.spec.ts \
  --run-id media-platform-v1 \
  --image ghcr.io/OWNER/spec-agent@sha256:DIGEST \
  --effort medium --max-turns 100 \
  --target-dir products/media-platform/backend \
  --shots 2 --concurrency 2 \
  --resume
```

Resume reconstructs the DAG from remote truth:

| Durable state | Resume behavior |
| --- | --- |
| Checked task branch and PR | Validate provenance and reuse the result |
| Pushed branch, missing PR | Create the PR and wait for checks |
| Closed PR | Reopen and refresh it |
| Merged immutable-task PR | Accept it as an already-published result |
| Failed/incomplete check | Start from the published head and create a retry checkpoint |
| No pushed task commit | Re-run from the immutable integration base |
| Missing worktree or container | Recreate it from GitHub state |
| Branch moved or plan changed | Refuse to resume |

An empty checkpoint commit is permitted only when resuming a published task
whose source does not need another change, for example after transient CI
failure.

Remote `fetch` and `ls-remote` reads have small bounded retries. PR creation is
idempotent by immutable head branch: after every create response, including an
error such as a lost GraphQL response, the adapter looks up the branch before
attempting another create. These are control-plane retries, not conformance
repairs. Agent execution and the compiler conformance judgment remain
single-shot for golden-rule evidence.

A run stopped only by Git/GitHub/network/container control-plane failure is
**checkpoint-resumable**, not golden-rule-invalid. Keep its run id and plan,
fix infrastructure if required, and resume it. Do not abandon checked commits,
replace the run with fresh repositories, or cancel a healthy sibling shot just
because another shot temporarily cannot publish. Fresh repositories are
required only after an actual conformance failure, evidence divergence, or
proven contract defect.

## Evidence and inspection

Local immutable inputs and reports are written under:

```text
.spec/generation/<shot-run-id>/plan.json
.spec/generation/<shot-run-id>/result.json
```

The result report includes the repository, local root, plan ref and SHA, every
task's branch, integration-base SHA, head SHA, PR, checks, timing, cost, skipped
tasks, and scheduler failures.

Useful read-only inspection commands include:

```bash
# List task PRs and their current heads/check state
gh pr list --repo OWNER/REPO --state all \
  --json number,title,state,headRefName,headRefOid,statusCheckRollup

# Inspect the immutable plan
git -C .spec/generation/RUN/repositories/shot-1 \
  show spec/generate/RUN-shot-1/plan:plan.json

# Inspect one task's provenance trailers
git -C .spec/generation/RUN/repositories/shot-1 \
  show --no-patch --format=full SPEC_TASK_HEAD_SHA

# Read evidence from the durable sink, not a mutable worktree
git -C .spec/generation/RUN/repositories/shot-1 \
  show SINK_SHA:products/APP/backend/conformance-output/openapi.json
```

Never use the `spec-lang` repository's `origin`, branches, commits, or PRs as
generation evidence. They belong to development of the tool, not to a shot.

## Failure policy

If any task, check, conformance judgment, or cross-shot comparison fails:

1. preserve the failed repositories, refs, PRs, checks, plans, and reports;
2. diagnose the contract gap from immutable evidence;
3. fix, in order of preference, specification vocabulary/validators, lowering
   and blueprint/oracle behavior, the example spec, or infrastructure-only
   harness defects;
4. rerun deterministic checks and dry-run stability first;
5. generate **all** shots again in fresh repositories with a new run id;
6. record the gap and result in `docs/golden-rule-results.md`.

Never modify generated source in a shot to pass verification, never repair
after conformance, and never substitute two branches or directories in one
repository for independent golden-rule shots.
