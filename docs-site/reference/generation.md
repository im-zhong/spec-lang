# Generation internals

Generation has two sharply separated halves:

- deterministic compilation produces the Spec IR, target blueprint, task DAG,
  exact prompts, scopes, verification plan, and compiler-owned oracle;
- GitHub execution gives each node an isolated worktree/container and publishes
  its result as a checked immutable commit.

The execution layer does not invent application behavior or reinterpret DAG
edges. For exact Git and GitHub mechanics, see [Git and GitHub
execution](/reference/github-execution).

## Package responsibilities

| Package | Responsibility |
| --- | --- |
| `@spec/fastapi` | Backend blueprint, DAG, prompts, verification, conformance, evidence commands |
| `@spec/react` | Frontend blueprint, DAG, Playwright oracle, visual/behavior evidence |
| `@spec/agent` | Projects compiler tasks into the durable execution plan and configures the agent runner |
| `@spec/execution` | Generic DAG scheduling, Git refs/worktrees/commits, containers, PRs, checks, resume |
| `@spec/cli` | Commands, temporary shot repositories, reports, cross-shot evidence comparison |

## Compiler generation plan

For a FastAPI target, `planGeneration(ir)` deterministically returns:

```ts
interface FastApiGenerationPlan {
  blueprint: BackendBlueprint
  dag: GenerationDag
  agentTasks: AgentTask[]
  conformance: { files: Record<string, string> }
  verification: VerificationPlan
  stable: string
}
```

The blueprint is the complete application contract. The DAG is a lowering of
that contract, not a suggestion to the agent.

For an IR containing `spec.module` nodes, `planCompositeGeneration(ir)` slices
the IR by declared ownership and lowers each FastAPI/React target independently.
Module tasks have namespaced ids, cwd, scopes, seed files, and oracle files.
They share only the frozen interface contract, have no provider/caller
scheduling edge, and converge on one final conformance node. React callers
receive a compiler-owned interface client; FastAPI providers must expose every
HTTP operation's exact method/path.

## Generation DAG

A typical backend graph is:

```text
project ──+──> models ──> schemas ─────────> entity routers ──+
          |       +──────> security ────────> auth router ─────+
          +──> database ───────────────────────────────────────+
          +──> cache ──────────────────────────────────────────+
          +──> messaging ──────────────────────────────────────+
          +──> blob ───────────────────────────────────────────+
                                                               v
                                                              app
```

Infrastructure nodes exist only when their contracts are present. Each router
is derived from its entity, route, auth, lifecycle, invariant, and effect
requirements. The app node depends on every component it must wire.

```ts
interface DagTask {
  id: string
  kind: string
  label: string
  dependsOn: string[]
  scope: string[]
  prompt: string
  specNodeIds: string[]
}
```

Task order, dependency arrays, scopes, prompt content, and prompt hashes are
stable. `agent.tasks.json` exposes this lowering during `--dry-run`.

## Projection into durable execution

`createGitHubGenerationPlan()` maps each compiler task without changing its
dependency edges. It prefixes every scope with the target product directory and
adds compiler-owned execution nodes:

```text
optional compiler-seed
        |
original generation DAG
        |
conformance materialization and one-shot verification
        |
optional OCI/container materializations
```

The resulting `AgentExecutionPlan` freezes:

```ts
interface AgentExecutionPlan {
  schemaVersion: "spec-agent-execution-plan/0.1"
  graphKind: "generation-execution"
  runId: string
  repository: string
  defaultBranch: string
  rootBaseSha: string
  branchPrefix: "spec/generate"
  environment: {
    image?: string
    runtime?: "docker" | "host"
    controlPlane?: "github" | "local"
    devcontainerHash: string
    toolchainLockHash: string
    agent: {
      model?: string
      effort: "low" | "medium" | "high" | "xhigh" | "max"
      maxTurns: number
      maxConcurrency: number
    }
  }
  acceptance: AgentExecutionAcceptance
  mergePolicy: "pull-request" | "merge-queue" | "merge-to-main"
  tasks: AgentExecutionTask[]
  fingerprint: string
}
```

The fingerprint is computed from a stable serialization of the full definition.
Plan validation rejects unsafe refs, non-digest images, invalid environment
hashes, missing agent pins, graph cycles, unknown dependencies, unsafe paths,
empty scopes, and unordered scope overlap.

## Agent execution environment

Agent nodes run the frozen prompt in a fresh container using a command shaped
like:

```text
claude -p --output-format json
  --safe-mode --no-session-persistence
  --permission-mode acceptEdits
  --model <pinned model>
  --effort <pinned effort>
  --max-turns <pinned limit>
  --allowedTools <audited file/Python allowlist>
```

The worktree is mounted at `/workspace`. The container root filesystem is
read-only; bounded tmpfs mounts provide `/tmp` and `/home/node`. The runner has
a 45-minute wall-clock budget by default. It receives only the credentials and
read-only agent configuration required for agent nodes.

Compiler `materialize` nodes do not invoke the coding agent and do not receive
those credentials. They write exact compiler strings within their declared
scope.

The container exit code is authoritative. Parsed JSON may contribute cost
evidence, but the agent never declares conformance.

## Task acceptance versus conformance

Agent tasks run a bounded implementation/test/reviewer synthesis loop before a
non-vacuous container acceptance command. Implementation and tests use
isolated, disjoint-scope snapshots; the reviewer is read-only. This establishes
node-level readiness and durable publication, but it is not the
application-level verdict and compiler conformance failures never re-enter the
loop.

The compiler-owned `conformance` node starts only after the generated app sink
is complete. For FastAPI it materializes:

| File | Purpose |
| --- | --- |
| `conformance/conftest.py` | Fresh configured application/client fixtures |
| `conformance/helpers.py` | Contract-derived valid bodies, references, users, and tokens |
| `conformance/test_contract.py` | Routes, CRUD, errors, auth, lifecycles, effects, invariants |
| `conformance/test_infrastructure.py` | In-memory and provider-adapter cache/messaging/blob contracts |
| `conformance/behavior_snapshot.py` | Canonical observable behavior evidence |
| `conformance/contract.json` | Frozen backend blueprint |

Its acceptance sequence creates a clean Python environment, installs the
project, imports the application, runs the suite once, and emits normalized
OpenAPI and behavior files. Nothing may modify generated source in response to
that judgment.

## Backend oracle coverage

The backend conformance suite derives assertions directly from the blueprint,
including:

- exact OpenAPI path/method/status/request-body/path-parameter surface;
- create, get, list, partial update, delete, and count semantics;
- response field sets, defaults, nullability, generated IDs, references, and
  deterministic ordering;
- exact authentication success/failure behavior and protected routes;
- validation, not-found, uniqueness, and conflict response bodies;
- lifecycle initial states, legal and illegal transitions, guards, and
  server-controlled state;
- set and emit effects with exact payload structure;
- row and cross-row invariants with rollback;
- cache policies, isolation, cache-aside behavior, and provider failure modes;
- messaging schema checks, stable envelopes, allowlists, ordering,
  at-least-once deduplication, and declared provider adapters;
- blob normalization, traversal rejection, size/MIME constraints, operations,
  signed URLs, and declared provider adapters.

Correctness depends on this coverage. Byte-identical evidence cannot make an
unasserted or incorrectly asserted behavior correct.

## Scheduling and file ownership

`@spec/execution` runs ready nodes in stable id order up to the immutable
per-shot concurrency. A child is ready only after all parents return successful
durable results. Fail-fast stops launching work after the first failure while
allowing already-running siblings to settle.

Every task has exact repository-relative paths. Before commit, the execution
adapter rejects any changed path outside that scope. Independent tasks cannot
share a path; ordered tasks may do so because the child starts from the
predecessor's checked commit.

Multiple dependency heads become a deterministic integration commit rather
than an agent-authored merge. See [How parallel results are
joined](/reference/github-execution#how-parallel-results-are-joined).

## GitHub checks

Each task PR triggers the generator-installed `spec-generation` workflow. The
workflow reads commands and the image from the immutable plan ref rather than
trusting files authored by the agent. The local orchestrator waits until the
required check is green for the exact expected PR head SHA.

Only after that point can a child consume the task's commit.

## Cross-shot golden-rule comparison

The CLI requires every shot report to be successful before comparing equality.
It then reads each declared evidence file from the exact durable sink SHA:

```ts
git show <sink-sha>:<target>/<evidence-file>
```

Every file is SHA-256 hashed. A multi-shot run succeeds only when every shot is
independently conformant and each evidence file has one hash across all shots.

For backend generation, the declared evidence normally consists of normalized
OpenAPI and canonical behavior JSON. For frontend generation it includes the
compiler-declared layout, behavior, and navigation artifacts.

## Local reports

Each shot writes `.spec/generation/<shot-run-id>/result.json`:

```ts
interface AgentExecutionReport {
  ok: boolean
  planFingerprint: string
  planRef: string
  planCommitSha: string
  tasks: Array<{
    taskId: string
    status: "review" | "failure"
    branch?: string
    integrationBaseSha?: string
    headSha?: string
    pullRequest?: { number: number; url: string }
    checks: AgentExecutionCheckResult[]
    diagnostics?: Diagnostic[]
    startedAt: string
    completedAt: string
    costUsd?: number
  }>
  skipped: string[]
  schedulerFailures: AgentExecutionScheduleFailure[]
}
```

The enclosing CLI result also records the shot repository, local clone, and
target directory. Generated source remains in the shot repository's task and
sink commits rather than in an `out/` directory in the compiler repository.

## Failure semantics

There is no generated-code repair loop. A failed agent node, container command,
Git publication, PR check, conformance run, or evidence comparison makes the
shot/run unsuccessful. Only bounded idempotent control-plane reads and PR
creation recovery may retry.

Fix the contract or execution implementation, rerun deterministic checks, and
regenerate all shots in fresh repositories. `--resume` reconstructs interrupted
publication; it does not turn a failed conformance judgment into a second
attempt.
