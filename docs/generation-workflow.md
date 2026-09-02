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
   One agent conversation may write only the node's compiler-owned file scope.
5. The host adapter audits exact changed paths and whitespace, creates a commit
   with run/task/fingerprint/dependency trailers, and pushes it.
6. One PR records the node result. A clean GitHub check must pass for the exact
   pushed head SHA before a child can consume it.
7. A child consumes only published dependency commit SHAs. It never reads a
   parent's local directory, stash, patch, or agent session.
8. The compiler-owned conformance node runs once after the generated-code sink.
   Failure is a spec/compiler defect; the agent does not repair toward tests.

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
  --target-dir products/media-platform/backend \
  --shots 1 \
  --concurrency 5

# same arguments, reconstructed from GitHub durable state
spec generate examples/media-platform/app.spec.ts \
  --run-id media-platform-v1 \
  --image ghcr.io/OWNER/spec-agent@sha256:DIGEST \
  --target-dir products/media-platform/backend \
  --shots 1 \
  --concurrency 5 \
  --resume
```

Multiple shots use independent run ids and output directories. Each shot uses
the identical compiler-owned DAG and conformance oracle.

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
