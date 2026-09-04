# GitHub-native generator execution and container specifications

The generator has one compiler-owned DAG. GitHub execution is the durable
execution model for that DAG; it is not a separate “development DAG”.

> Local worktrees, containers, caches, and uncommitted files are disposable.
> The canonical plan, pushed commits, PRs, checks, and OCI digests are durable.

## One DAG, durable node execution

The target package derives the same narrow generation nodes it always did:

```text
Spec IR → blueprint → project → models/database → schemas/routers → app
                                                            ↓
                                               compiler conformance
                                                            ↓
                                                container artifacts
```

`@spec/agent` projects each node onto `@spec/execution`. The projection adds
execution metadata—base SHA, branch, image digest, checks, and PR—but does not
add a second set of business dependencies or reinterpret prompts.

For run `R` and generator node `T`:

1. Planning is allowed only from a completely clean checkout whose `HEAD`
   already exists on `origin`.
2. The canonical byte-stable execution plan is published at the immutable
   ref `spec/generate/R/plan`.
3. A ready node gets an immutable integration-base ref and branch
   `spec/generate/R/T`.
4. A fresh digest-pinned container receives a disposable detached worktree.
   An agent node runs a bounded synthesis loop. Its implementation and unit-test
   Claude instances start concurrently from separate snapshots of the same
   frozen spec progress and have disjoint exact scopes. The harness audits each
   snapshot before merging it into the node workspace.
5. A read-only reviewer Claude runs the declared tests, reviews code and tests
   against the frozen spec, and returns a structured approve/reject verdict.
   Rejection starts the next bounded synthesis round with feedback for both
   writers. Reviewer changes to files are rejected by the harness.
6. After reviewer approval, the compiler-owned node acceptance runs exactly
   once. Its result never becomes repair feedback. The final compiler-owned
   conformance node still runs exactly once after the generated-code sink.
7. The host adapter audits exact changed paths and whitespace, creates a commit
   with run/task/fingerprint/dependency trailers, and pushes it.
8. One PR records the node result. A clean GitHub check must pass for the exact
   pushed head SHA before a child can consume it.
9. A child consumes only published dependency commit SHAs. It never reads a
   parent's local directory, stash, patch, or agent session.
10. Conformance failure is a spec/compiler defect; no agent repairs toward the
    compiler oracle.

Independent ready nodes run concurrently because they have distinct worktrees,
containers, branches, conversations, scopes, and logs. An unordered overlap in
write scopes is rejected before execution. Multiple parents are combined with
a deterministic `git merge-tree`/`commit-tree` integration commit; a conflict
is a structured failure, never an agent choice.

```text
origin/main@base
    ├─ project ─ commit/PR ─┬─ models ─ commit/PR ─┐
    │                       └─ database ─ commit/PR ┤
    │                                              ├─ app ─ conformance ─ final PR
    └──────────────────────────────────────────────┘
```

## Recovery and trust boundary

`spec generate ... --resume` reconstructs state from the remote plan ref,
task branches, commit trailers, PR head SHAs, and required checks. A fresh
clone explicitly fetches remote task heads before provenance validation.

Common crash windows are recoverable:

- push succeeded but PR creation failed: resume creates the missing PR;
- a check failed: resume starts at the published task head and pushes a new
  retry checkpoint (an empty checkpoint is valid when only CI was transient);
- a container or worktree vanished: it is recreated from the remote SHA;
- no commit was pushed: that local work is intentionally lost and the node is
  rerun from its integration base.

Plans supplied to the agent are not arbitrary local JSON. The CLI compiles the
plan from the published root commit, fingerprints it, and publishes it to an
immutable Git ref before any prompt or acceptance command runs. Agent
credentials are exposed only to agent nodes, through read-only mounts or named
environment variables; compiler materialization nodes receive no credentials.

Every plan also carries a shot-independent `semanticInputDigest`. The immutable
compiler seed embeds `.spec-input/` source, manifest, Spec IR, blueprint, DAG
with full prompts, verification plan, and oracle bytes. Repository/run identity
changes the execution-plan fingerprint but not this semantic digest, allowing
cross-shot input equality to be proven before output comparison.
Local planning writes the same inputs atomically to
`.spec/inputs/<content-sha256>/`; the legacy root artifacts are refreshed from
that same compile so IR/manifest and blueprint/DAG cannot silently describe
different examples.

When Spec IR declares `spec.module` units, `spec generate` emits a composite
workspace instead of selecting one global target. FastAPI and React module
DAGs use disjoint namespaced directories and run concurrently from the same
frozen interface contract. No provider-to-caller scheduler edge is added.
All module sinks feed one compiler conformance node, which materializes and
runs every module oracle once. HTTP providers are rejected during lowering if
their blueprint lacks a route declared by the interface transport ABI.

## CLI

Planning without execution remains local and deterministic:

```bash
spec generate examples/media-platform/app.spec.ts --dry-run
```

Actual generation uses GitHub/container execution:

```bash
spec generate examples/media-platform/app.spec.ts \
  --run-id media-platform-v1 \
  --image ghcr.io/OWNER/spec-agent@sha256:DIGEST \
  --effort high --max-turns 100 \
  --target-dir products/media-platform/backend \
  --shots 2 \
  --concurrency 2

# same arguments, reconstructed from GitHub durable state
spec generate examples/media-platform/app.spec.ts \
  --run-id media-platform-v1 \
  --image ghcr.io/OWNER/spec-agent@sha256:DIGEST \
  --effort high --max-turns 100 \
  --target-dir products/media-platform/backend \
  --shots 2 \
  --concurrency 2 \
  --resume
```

Fast iteration can skip both GitHub and Docker — no `gh`, no container
engine, and no `--image`. `--execution local` gives each shot a bare Git
remote plus clone under `<repo-parent>/.spec-local/<repo>/<run-id>/`
(outside this checkout), and `--runtime host` runs the agent and acceptance
commands directly in the per-task worktrees:

```bash
spec generate examples/media-platform/app.spec.ts \
  --run-id media-fast-1 \
  --effort low --max-turns 40 --shots 1 \
  --execution local --runtime host
```

Local runs use the identical orchestration path — task branches, per-branch
verification of the pushed head, and deterministic `merge-to-main` landings —
but are not golden-rule evidence; that still requires GitHub repository
isolation.

Multiple shots use independent temporary GitHub repositories, independent
local checkout/worktree roots, and independent run ids. The generator creates
the repositories through `gh`; callers may supply an owner/name prefix but do
not pre-create concrete shot targets. Different directories or branches in one
remote do not qualify as independent shots. Each repository receives the
identical compiler-owned DAG, conformance oracle, and pinned environment.

Shot clones and remotes use GitHub's SSH endpoint on port 443. This preserves
SSH-key write permission for the compiler-owned workflow while avoiding a
dependency on outbound port 22. Resume validates the existing clone's
repository identity before normalizing its `origin` to that transport.

## Reproducible agent environment

The repository owns `.devcontainer/Dockerfile`, its lockfile, and toolchain
versions. Execution requires an OCI reference pinned by digest. The plan also
records hashes of the environment definition and repository lockfiles.

The only assumed host facilities are Git, a container engine, and GitHub
credentials. Host package installations and caches are accelerators, never
inputs. CI rebuilds the repository image, runs the monorepo tests, reruns any
generated conformance suite, and verifies emitted OCI contracts.

## Container specification hierarchy

Containerization is compiler vocabulary rather than an agent-authored
Dockerfile prompt:

1. `container(name, ...)` defines generic OCI build/runtime policy.
2. `backendContainer(name, ...)` binds a backend service, dependency install,
   exec-form startup, port, health, shutdown, and non-root policy.
3. `frontendContainer(name, ...)` binds a frontend build to a lockfile-driven
   install and multi-stage build, then serves its output through a defined
   nginx document root with explicit SPA fallback.

All base/build/runtime images are digest-pinned. The generic contract validates
platform, exact workdir, non-root user and group (including rejection of every
`root:*`/UID-0 spelling), environment names, exec-form commands, health checks,
read-only-root intent, init behavior, signal, port, and service ownership.

Lowering deterministically emits:

- Dockerfile and `.dockerignore`;
- build-context manifest and semantic fingerprint;
- runtime contract and source/task OCI labels;
- frontend nginx configuration when applicable;
- compiler-owned config, actual-UID, startup/health/shutdown tests;
- an OCI archive carrying SPDX SBOM and SLSA provenance attestations, plus an
  attestation verifier.

The CI check builds an attested OCI archive, verifies both predicate types,
loads a runtime image, inspects its OCI config, proves `id -u != 0`, and tests
lifecycle behavior. Registry publication belongs to protected CI/OIDC; secrets
are never accepted as spec values or image build arguments.

## Implementation boundary

- `@spec/fastapi` / `@spec/react`: derive the original generation DAG,
  prompts, compiler oracle, and verification commands.
- `@spec/agent`: maps those nodes unchanged into durable GitHub execution.
- `@spec/execution`: generic Git/worktree/container/PR/check/resume mechanics;
  it owns no application DAG and no domain semantics.
- `@spec/container`: generic/backend/frontend OCI vocabulary and lowering.

Unit tests cover deterministic plans, parallel gating, exact-scope commits,
immutable plan refs, cross-clone fetch/provenance, resume, root-user rejection,
and byte-stable container outputs. The final dogfood gate is a real
`media-platform` generation run whose local worktrees and containers can be
deleted and reconstructed solely from GitHub plus the pinned agent image.
