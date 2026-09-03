# Media-platform v6 design audit

This report records the terminal result of
`media-platform-golden-20260903-v6`, the evidence recovered from both complete
generated codebases, and the changes required before another golden-rule run.

The generator is intentionally paused after both shots finished. No generated
code was repaired, and no replacement run was started while producing this
report.

## Executive verdict

The v6 run is **not golden-rule evidence**:

- shot 1 reached the compiler-owned oracle and failed 9 of 85 tests;
- shot 2 failed the oracle's application-import gate;
- the final `containers` node was skipped in both shots;
- equality and correctness comparison cannot begin because neither shot was
  individually conformant on its first judgment.

The failures are not nine unrelated agent mistakes. They expose four immediate
contract/compiler defects:

1. auth routes have two owners in the DAG;
2. the blob prompt and blob oracle specify different Python APIs;
3. every agent node is accepted by the literal command `true`, so invalid or
   incomplete artifacts travel all the way to final conformance;
4. exact, mechanical artifacts such as response schemas and router manifests
   are still delegated to a probabilistic agent.

Fixing only shot 2's bad SQLAlchemy import would therefore be insufficient.

## Frozen run and evidence

Both shots used independent private GitHub repositories and independent local
roots. After a GitHub SSH port-22 interruption, the same immutable v6 plans were
resumed over `ssh.github.com:443`; completed checkpoints were reused. This was a
control-plane recovery, not a golden-rule reroll.

| Item | Shot 1 | Shot 2 |
| --- | --- | --- |
| repository | `im-zhong/spec-mediaoperationsapi-backend-media-platform-golden-20260903-v6-shot-1` | `im-zhong/spec-mediaoperationsapi-backend-media-platform-golden-20260903-v6-shot-2` |
| app branch | `spec/generate/media-platform-golden-20260903-v6-shot-1/app` | `spec/generate/media-platform-golden-20260903-v6-shot-2/app` |
| app commit | `9b73db81697460693d07c2d0ae977726701634f7` | `203d231e468ae5f11e7ddbc729318f6682c58a90` |
| app PR | `#20` | `#20` |
| agent nodes completed | 20 | 20 |
| conformance | 76 passed, 9 failed | import gate failed |
| final container node | skipped | skipped |
| recorded agent cost | $7.06952 | $5.71570 |

The two full plan fingerprints differ because repository and run identity are
part of each plan. After removing shot-specific paths and identity, the task
semantics, prompts, materializations, and acceptance rules have the same SHA-256:

```text
7bb15529a48773a961efd39a62002ad2415fa89a8aecc558c18c62d1ef6fc258
```

The evidence used by this audit is preserved at:

- `.spec/generation/media-platform-golden-20260903-v6-shot-1/plan.json`
- `.spec/generation/media-platform-golden-20260903-v6-shot-1/result.json`
- `.spec/generation/media-platform-golden-20260903-v6-shot-2/plan.json`
- `.spec/generation/media-platform-golden-20260903-v6-shot-2/result.json`
- `.spec/generation/media-platform-golden-20260903-v6/inspection/shot-1-app/`
- `.spec/generation/media-platform-golden-20260903-v6/inspection/shot-2-app/`

The shot 1 oracle was also materialized unchanged into
`.spec/generation/media-platform-golden-20260903-v6/analysis/shot-1-conformance/`
and replayed only to recover assertion details truncated from `result.json`.
That replay is diagnostic evidence, not a second conformance judgment.

## Exact failure analysis

### Shot 1

The 9 failures reduce to three causes.

| Failed tests | Observed result | Contract result | Cause |
| --- | --- | --- | --- |
| `test_login_wrong_password`, `test_login_unknown_identity` | `401 {"detail":"Not authenticated"}` | `401 {"detail":"Invalid credentials"}` | `router-User` and `router-auth` both generated the same three auth routes. `app/main.py` chose the User router's implementation and did not mount the dedicated auth router. |
| asset create/list/get and transitions accept/reject/remove | response omitted `uploadedBy` | every declared Asset field must be present | `AssetOut` omitted one of the IR's twelve declared fields. The schemas node still passed because its acceptance command was `true`. |
| `test_blob_contract` | `AttributeError: 'str' object has no attribute 'key_prefix'` | blob calls accept a declared policy name | the generated implementation followed the prompt's `BlobPolicy`-object API, while the oracle passed `"Derivatives"`, `"Exports"`, or `"Originals"`. |

The auth failure is a compiler ownership bug, not a reasonable integration
choice. The blueprint assigns auth routes `entity: "User"`. The generic router
builder selects every route whose `entity` is User, and the DAG independently
creates `router:auth`. The application prompt then says to include every router.
No possible app-wiring decision can make those three statements simultaneously
true without duplicate routes.

The global prompt also calls every 401 `Not authenticated`, while the local
login requirement and blueprint error contract require `Invalid credentials`.
Errors need endpoint-specific ownership instead of one global sentence.

### Shot 2

Application import stopped at:

```text
app/routers/delivery.py:26
from sqlalchemy import DeclarativeBase, func, select
ImportError: cannot import name 'DeclarativeBase' from 'sqlalchemy'
```

`DeclarativeBase` lives in `sqlalchemy.orm`, but this router did not need to
own or import an ORM base at all. A prompt guard for this specific error has
already been added locally, with a unit regression, but that narrow correction
does not address the run's other findings.

Static inspection found at least two failures that would remain after the
import error:

- shot 2 declares the extra route `GET /api/v1/api-keys/count`, which is absent
  from the 62-route blueprint;
- its app mounts both `router-User` and `router-auth`, so the three auth routes
  exist twice and dispatch depends on registration order.

The golden rule prohibits bypassing the import error and treating later tests
as another judgment. These are static audit findings, not a repaired run.

## Cross-shot code comparison

The repositories have the same 24-file manifest, but every corresponding file
differs. All 22 Python files differ; the aggregate no-index diff contains 3,049
insertions and 3,499 deletions. Shot 1 has 5,112 Python lines and shot 2 has
4,668.

Source-byte equality is not itself required: the golden rule compares observable
software behavior. The scale and location of these differences nevertheless
show how many unpinned decisions remain. Examples include:

- different JWT environment-variable aliases, fallback secrets, expiry logic,
  algorithm configurability, and bcrypt cost handling;
- different public helper classes and functions in cache, blob, messaging,
  database, and model modules;
- different router prefix conventions and app mount strategies;
- different event model names (`Event` versus `OutboxEvent`);
- different build-system constraints (`hatchling>=1.26` versus unpinned
  `hatchling`).

Most of these dimensions are absent from normalized OpenAPI and the current
behavior snapshot. Two future shots could therefore pass the existing equality
check while behaving differently in deployment.

## Design defects by layer

### P0 — fix before spending on another shot

#### 1. Route ownership is not unique

`BackendRoute.entity` is being used both as a response-domain reference and as
a task owner. That makes auth routes look like User CRUD routes. The generic
User router and the dedicated auth router both receive them.

Required change:

- add an explicit route family/owner to the blueprint, such as
  `owner: { kind: "crud", nodeId: "crud:User" }` or
  `owner: { kind: "auth", nodeId: "auth:MainAuth" }`;
- give every route a stable source node id;
- make DAG construction group only by owner, never by response entity;
- reject a blueprint unless every route has exactly one producing task;
- generate the router registry/mount table deterministically rather than ask
  the app agent to reconcile routers.

This also fixes inaccurate provenance: a router with any count operation is
currently tagged with every `api:*` count node id, not only its own.

#### 2. Blob ABI has two truths

The prompt says `normalize_blob_key(policy, key)` and describes a
`BlobPolicy`-object API. The oracle calls every method with a policy name string.

Required change:

- represent the module ABI in machine-readable blueprint data, including exact
  parameter types and lookup behavior;
- choose one public form. The recommended form is a policy name string because
  it crosses JSON/configuration boundaries cleanly and matches cache/messaging;
- generate prompt text, type declarations, static checks, behavior tests, and
  snapshots from that same ABI object;
- add a compiler unit test proving a prompt example and oracle call use the
  same selector type.

#### 3. Agent-node acceptance is vacuous

Every one of the 20 agent nodes uses:

```json
{"commands":["true"],"requiredChecks":["spec-generation"]}
```

The green task PR/check therefore means only that the agent wrote within scope,
committed, and published. It does not mean the artifact imports or implements
its declared interface. This allowed a missing response field, an invalid
import, and an extra route to consume the entire downstream DAG and roughly
$12.79 before discovery.

Required change:

- run one compiler-owned, non-repairing acceptance judgment after every node;
- project: parse `pyproject.toml` and assert the exact dependency lock;
- models/schemas: import or statically inspect exact classes, fields, aliases,
  defaults, hidden columns, and enum values;
- database/security/infrastructure: import and probe the exact public ABI;
- router: import the module and compare its route manifest, methods, paths,
  status codes, dependencies, and response schema to that task's owned routes;
- app: import once and compare the complete 62-route manifest before the full
  behavioral oracle.

A failed node ends that shot. It must not receive a repair turn. Network or
publication interruption still resumes the same immutable checkpoint.

#### 4. Mechanical contract code is delegated to an agent

Entity models, Pydantic schemas, dependency pins, policy tables, and route
registration are direct translations of IR. Letting an agent reproduce them
creates variance without adding useful design judgment. `uploadedBy` is the
smallest example.

Required change:

- compiler-materialize `pyproject.toml`, entity models, request/response schema
  definitions, policy constants, router manifests, and app router registration;
- give agents bounded implementation slots only where synthesis is necessary;
- keep compiler-owned files outside agent scope and audit that boundary;
- derive both conformance and generated skeletons from the same canonical ABI.

### P1 — correctness and auditability

#### 5. Infrastructure declarations are not connected to application behavior

The spec declares caches, queues, messages, blob policies, and providers, but
does not declare which route or transition uses them. In v6 the app merely puts
three in-memory adapters on `app.state`; CRUD and lifecycle behavior can pass
without using them.

There is also no typed link between lifecycle strings such as `asset.ready` and
declared messages such as `AssetReady`; their field names do not even match
automatically (`id` versus `assetId`, `project` versus `projectId`).

Required vocabulary/IR additions:

- `effect.publish(MessageRef, fieldMap, destinations)` instead of a free-form
  event string;
- cache binding to explicit operations plus read, write, invalidation, failure,
  and stampede semantics;
- blob binding to an entity field/operation and lifecycle policy;
- an explicit runtime profile that says when in-memory adapters are legal and
  how production providers are constructed, configured, injected, and closed;
- compile-time validation that all field maps, ordering keys, queue message
  memberships, and provider bindings resolve.

#### 6. Auth behavior is under-specified

The spec selects password auth, but runtime-observable decisions such as JWT
algorithm, expiry, secret environment name, issuer/audience, inactive-user
behavior, and bcrypt cost are supplied by prompt prose or invented by agents.

Move these values into auth IR and add endpoint-specific error contracts.
`unauthenticated` and `invalidCredentials` must remain separate error variants,
not be collapsed into a global status-code rule.

#### 7. The oracle covers presence better than correctness

The HTTP oracle has useful coverage of CRUD, state transitions, invariants,
counts, auth, and exact entity keys. Infrastructure coverage is much thinner:

- messaging checks validation and one provider publish call, but not retries,
  backoff, acknowledgement, consumption, or terminal dead-letter behavior;
- cache checks sequential `get_or_set`, not concurrent stampede suppression or
  expiry behavior;
- blob checks object operations, but not retention or configured S3 client
  construction;
- no test proves an HTTP mutation invokes its declared cache, message, queue,
  or blob behavior;
- the behavior snapshot does not normalize JWT policy, provider configuration,
  router duplication, or most lifecycle side effects.

Correctness requires feature-to-oracle traceability: every served spec node and
every declared attribute needs at least one executable assertion or an explicit
compile-time proof.

#### 8. Failure evidence is incomplete

The immutable remote plan branch contains only `plan.json`. It does not preserve
the source spec, full Spec IR, blueprint, compiler diagnostics, or an independent
semantic-input digest. The local result stores only a bounded diagnostic tail;
that is why eight shot 1 assertions had to be replayed. A failed conformance
node also has no remote conformance/evidence commit.

The root `.spec/` directory can contain mixed artifacts from different commands:
before this audit, `blueprint.json` described media-platform while
`spec.ir.json` and `manifest.json` still described basic-web-app. `generate
--dry-run` refreshed the blueprint and DAG but not those two files; only a later
explicit `spec build` made the set coherent.

Required change:

- write every command into a fresh, run-addressed artifact directory and publish
  it atomically;
- freeze source spec, manifest, IR, blueprint, DAG, prompts, oracle, toolchain,
  and hashes in the plan/evidence ref;
- store complete stdout/stderr as immutable artifacts with hashes; keep a short
  tail only as the human summary;
- publish a compiler-owned failure-evidence ref even when no generated-code PR
  is eligible for merge;
- provide a semantic-input hash that is identical across shots and separate it
  from the repository/run-specific execution-plan hash.

### P2 — throughput and execution

#### 9. Git isolation works, but semantic conflicts bypass Git conflicts

Parallel tasks own disjoint files, so Git can combine them without textual
conflicts. Duplicate route ownership is a semantic conflict across two files;
Git cannot detect it, and the app agent was forced to choose registration order.

Each node should publish a compiler-validated interface manifest. Before a
consumer runs, the scheduler should merge parents and validate those manifests
for duplicate routes, duplicate exports, missing imports, and incompatible ABI.
Compiler-generated integration files remove most of this class entirely.

#### 10. Expanding concurrency to 8 needs a pinned resource gate

The CLI currently defaults to total concurrency 2. With two shots, each v6 plan
was pinned to `maxConcurrency: 1`. A total concurrency of 8 would run the two
shots in parallel with up to four nodes per shot.

That is the requested target, but an earlier four-container run exhausted a
4-GiB Docker VM. The safe design is:

- change the default total concurrency to 8;
- pin total and per-shot concurrency in the immutable plan;
- estimate/reserve memory and CPU per executor class before creating any shot
  repository;
- require a documented minimum (or explicit container resource limits) and stop
  at preflight when eight workers cannot be supported—never silently change the
  frozen concurrency;
- share only immutable package/download caches, never workspaces or Git state;
- keep global admission control across both shots, with fair per-shot slots;
- add stress tests for fail-fast, resume, publication retries, and peak worker
  count at 8.

## Implementation plan

### Phase 0 — preserve the failed run

- Keep both repositories, PRs, plans, results, app branches, and inspection
  clones unchanged.
- Record the final v6 result in `docs/golden-rule-results.md`.
- Do not resume v6 again: both first judgments are terminal failures.

### Phase 1 — close the three observed contract failures

1. Add route owner/family to blueprint types and lowering.
2. Exclude auth operations from generic entity routers and assert unique route
   ownership.
3. Remove the conflicting global 401 wording; derive endpoint error matrices.
4. Define the blob ABI once and generate prompt/oracle calls from it.
5. Add exact schema and router-manifest node acceptance.
6. Keep the already-added SQLAlchemy import/base ownership regression.

Regression fixtures must prove that the compiler rejects all known v6 shapes:
missing `AssetOut.uploadedBy`, extra `api-keys/count`, duplicate auth routes,
top-level `sqlalchemy.DeclarativeBase`, and object/string blob selector drift.

### Phase 2 — reduce agent freedom

- Compiler-generate mechanical modules and the router registry.
- Add machine-readable module ABIs to the blueprint.
- Have each task consume dependency interface manifests, not infer conventions
  from arbitrary source code.
- Replace `true` acceptance for every agent task with its compiler-owned gate.

### Phase 3 — make the spec operationally complete

- Add typed message emission and field mapping.
- Add cache/blob operation bindings.
- Pin the complete auth runtime policy and provider lifecycle profile.
- Reject unbound served infrastructure at `spec check`, or mark it explicitly
  as library-only so correctness has a precise meaning.

### Phase 4 — strengthen oracle and evidence

- Generate a feature-to-assertion coverage manifest.
- Test infrastructure failure/retry/concurrency semantics and HTTP integration.
- Expand normalized behavior evidence to every declared behavior surface.
- Make run artifacts atomic and publish full success/failure evidence.

### Phase 5 — raise concurrency to 8

- Add resource-aware preflight and global/per-shot scheduling tests.
- Change the CLI/help default only after the eight-worker stress suite is green.
- Verify that checkpoint recovery still reuses completed nodes after injected
  GitHub transport and control-plane failures.

### Phase 6 — fresh golden-rule judgment

Before agent spend, all of the following must be green:

```text
pnpm build
relevant unit/integration tests
spec check examples/media-platform/app.spec.ts
two identical dry-run semantic hashes
unique route ownership check
non-vacuous acceptance for every agent node
complete immutable evidence bundle check
negative replay that catches every known v6 defect
eight-worker resource preflight
```

Then generate **both shots from scratch in two new repositories**. No v6 code or
task branch may be reused. Each shot receives exactly one conformance judgment.
Only after both pass should the compiler compare normalized OpenAPI, expanded
behavior evidence, and declared correctness coverage. A final PR may target
`main` only from the successful sink after conformance and container checks.

## Decision

Do not start v8 yet. The next action is to implement and test Phases 1–5 in the
compiler/spec-lang repository, then perform the fresh two-shot run described in
Phase 6.
