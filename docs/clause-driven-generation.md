# Clause-Driven Generation

Status: implemented (2026-09-04). This document is the design record for the
generation-loop architecture that replaced the three-role
(implementation / tests / reviewer) loop with a two-role loop plus
compiler-generated oracles, driven by machine clause tables.

## 1. Motivation

The golden rule read literally: **every decision an agent makes is a
contract the spec failed to pin**. The old loop violated this at its core —
the tests that judged each node were authored by an LLM, shot by shot,
round by round. Two shots therefore ran under two different judgments, and
the loop's "do not weaken tests" instruction was a social norm, not a
mechanism. Defect #33 (tests-role path defined in prose, cross-shot
divergence) was an early symptom; this design is its terminal fix.

Design principles:

1. **One clause table per node, four projections**: the implementation
   prompt kernel, the compiler-generated node oracle, the reviewer
   checklist, and the plan fingerprint all render from the same data.
2. **Judgment is deterministic**: node acceptance runs compiler-owned
   oracle files, identical across shots and frozen from round 1.
3. **Roles shrink to what cannot be mechanized**: implementer (writes
   source) and reviewer (judges review-kind clauses by inspection).
4. **Test granularity = contract granularity**: oracles exist exactly where
   the spec pins checkable behavior; anything deeper is implementation
   freedom, and deep behavioral judgment stays with the conformance suite.
5. **No improvisation over defects**: the challenge protocol gives the
   implementation agent exactly one correct response to an unsatisfiable
   contract — reject it with a clause id.

## 2. Schema (`packages/core/src/clauses.ts`, `types.ts`)

```ts
interface ContractClause {
  id: string          // clauseId("route", "POST /api/posts") => "route:POST /api/posts"
  statement: string   // single-sentence imperative, rendered verbatim everywhere
  node: string        // owning generation node, e.g. "router:Booking"
  kind: string        // route | error | abi | import | pin | column | invariant |
                      // transition | serialization | adapter | selector | app | file | review
  verification: "oracle" | "lint" | "review"
  level: "api" | "function"
}
```

`clauseTable(node, clauses)` sorts by id and enforces (node, id)
uniqueness, so tables are `stableStringify`-stable by construction. IDs
derive only from identifiers already in the blueprint (route ids,
`invariant:<name>`, entity/field names, transition events, module exports)
— no new source of truth.

The **verification line** (v1):

- `oracle` (default): import/export surfaces, route tables, table
  metadata, pins, schema field sets, pure module behaviors, the app's
  OpenAPI interface, fake-client adapter shapes.
- `review`: contract-shaped but not node-mechanically decidable — "no APIs
  beyond the declared list" for infra/database internals, guard-evaluation
  quality, exact file sets. ≈0–5 per infra node.
- `lint`: reserved; v1 emits zero.

Engineering guidance is **not** a clause; it stays in the role brief.

## 3. Derivation (`packages/fastapi/src/clauses.ts`)

`clausesByTask(bp)` mirrors `buildTaskDag`'s task set exactly: project
(pins, files), models (table + per-column shape incl. implicit id /
created_at / password column and the outbox table), database (export ABI,
URL resolution truth table, sessionmaker/engine flags, review: no-extra),
schemas (`<E>Create/Update/Out` field sets — the class names are now
pinned), security (bcrypt-direct, verify(None), token roundtrip, exact 401
body), router per entity (one clause per route with operation semantics,
per-route error clauses, transition clauses with guard/effects JSON,
invariant fan-in via `route.invariantIds`, import clauses incl.
count-before-`{id}`), router:auth (exact login/register/me bodies),
cache/messaging/blob (export lists, selector, per-provider adapter calls,
fail-closed semantics), app (create_app ABI, strict route-interface
equality, engine isolation, app.state adapters).

## 4. Projections

- **Kernel** (`prompt.ts renderKernel`): task header, the clause table as
  a numbered checklist (`- [route:POST /bookings] statement`, api before
  function, review clauses marked), forbidden extras, shared operational
  constraints (error bodies, SQLite-only SQL, `id` path params), and the
  challenge protocol.
- **Brief** (`renderBrief`): package guidance + reference data blocks
  (entity/guard/effects/check-tree JSON), explicitly subordinate.
- **Oracle** (`oracle.ts`): `tests/spec_oracle/runner.py` (one generic
  CONTRACT interpreter per module) + `test_<task>.py` per node — three
  lines plus a CONTRACT literal. The contract embeds the clause manifest;
  review-kind clauses are listed, never machine-checked.
- **Reviewer**: same clause table with oracle clauses marked
  "machine-verified — check for gaming" and review clauses "verify by
  inspection"; feedback must be keyed to clause ids.

## 5. Loop v0.2 (`spec-agent-task-loop/0.2`)

```text
for round in 1..maxRounds:
  writer  = exec implementation.instruction + frozen-context + ownership line
  challenge? -> SPEC_CONTRACT_CHALLENGED, terminate (no retry, spec defect)
  audit   = writes outside implementation.scope -> failure
  evidence = reviewer.commands (the compiler oracle) output
  review  = read-only reviewer -> {"approved":bool,"feedback":"..."}
  approved? -> done; else feedback feeds the next round
exhausted -> task failure
```

Single writer runs directly in the task workdir (the v0.1 snapshot/merge
machinery is deleted). Checks are named
`generation/loop/<n>/{implementation,review}` (plus `…/challenge` on a
challenge). `execution/src/validate.ts` enforces the v0.2 shape and
`AGENT_EXECUTION_LOOP_CLAUSE_INVALID` (duplicate ids, empty statements,
out-of-enum verification/level, clause.node ≠ task id).

## 6. What stays where

- **Node oracle** = ABI slice + node-testable behavior; catches contract
  violations early, in-loop, deterministically.
- **Conformance suite** (unchanged) = the app-level final judgment: strict
  OpenAPI equality, full CRUD/transition/invariant behavior, interface
  live-contracts, cross-shot evidence byte-equality.
- **Reviewer** = the judgment half machines cannot do.
- **GitHub workflow** (unchanged) re-runs `acceptance.commands` from the
  immutable plan — which is now the oracle command, so the durable
  per-node judge is also compiler-owned.

## 7. Determinism rules

Clause tables sort by id; `dagFingerprint` and `planGeneration.stable`
include them; the plan fingerprint covers the loop (including reviewer
clauses and oracleFiles) via canonicalization in `execution/src/plan.ts`.
Oracles and prompts are pure functions of the blueprint; double dry-runs
are byte-identical (verified for booking, media-platform, store-platform,
interface-workspace, frontend-golden).

## 8. React treatment

The single frontend task derives a small clause table
(`frontend:pin:*`, `frontend:file:*`, `frontend:import:*`, plus two review
clauses) and seeds `tests/frontend.contract.test.mjs` — a node:test oracle
asserting pins, `index.html` shape, the exact `main.tsx` import set, and
screen-path uniqueness. Same v0.2 loop, `node --test` as the command.

## 9. Migration note

Loop schema jumped 0.1 → 0.2; plans are not resume-compatible across the
boundary (by design: prompt semantics changed). The store-platform
`store-platform-golden-20260903-v7` paused run is permanently
non-resumable and is superseded by this design. Replay handbooks are
regenerated via `scripts/export-agent-prompts.mjs` (updated to the v0.2
formulas; see `examples/store-platform/prompts.md`).

## 10. Deferred / next

- First paid validation: booking `--shots 2` smoke, then store-platform
  golden run under the new loop (expect ~⅓ fewer agent execs per node).
- Oracle probe depth can grow (router HTTP behavior via a throwaway
  app+sqlite client) as clause vocabulary grows; every new probe must
  trace to clause ids.
- `lint` verification remains reserved for real lint rules.

## 11. Addenda (2026-09-05)

- **Oracle v2 — in-loop behavior execution**: router node oracles no
  longer stop at shape. Each router CONTRACT now embeds a `behavior`
  block of interpretable `{given, request, expect}` triples — rule-derived
  probes for every owned route (create echo/conflict/dangling/422/bounds,
  get/list/update/delete, every transition direction incl. a statically
  derived guard-violation probe, protected-route 401) PLUS the author
  examples targeting those routes, verbatim. The runner assembles a
  throwaway app per triple (FastAPI + only this router + in-memory SQLite
  + a `get_db` override), seeds fixtures by direct table inserts (sibling
  routers do not exist yet; uuid/datetime column values are coerced),
  sends real HTTP, and asserts status/body predicates/bindings, exact key
  sets, list shapes, table counts, and outbox event payloads. Every value
  is a compiled literal (deterministic uuids, guard-directed samples
  evaluated tri-state at compile time), so the block is byte-stable.
  Behavior defects die in loop round 1 instead of detonating at the
  single-shot terminal conformance. Verified three ways: py_compile across
  all examples, a green run against a hand-written contract-conformant
  node implementation, and two mutations (guard boundary off-by-one,
  dropped emit) both rejected with labeled triples.

Three contract surfaces landed on top of the v0.2 loop, all in the same
discipline (pure data → clause table → frozen bytes; agents author no
tests, ever):

- **Field bounds** (`field.int().min/.max`, `field.string().maxLength`):
  validation vocabulary answering the default 422, deliberately distinct
  from invariant semantics (409). Bounds flow into schemas clauses
  (`schemas:<E>:bound:<f>`), the schemas node oracle asserts the pydantic
  constraints, and conformance clamps every sampler into bounds while
  probing both sides of each boundary (min-1/min/max+1 → 422, distinct
  in-bounds value → 201).
- **`@spec/test` example vocabulary** (`example`/`op`/`fixture`): an
  author-declared input→output contract — the strongest per-route test.
  Resolution, input completeness, and field/binding validity are checked
  at `spec check` (EXAMPLE_* diagnostics); each example lowers onto its
  owning router node as a `test` clause (values included) and into a
  frozen `conformance/test_examples.py` (literal body in, pinned status +
  body subset out; fixtures are overrides over the synthesized world).
  `examples/bounds` is the fixture spec; subset match is the default
  because exact response key sets are already pinned by rule-derived
  clauses.
- **Expectation language v2** (same day): body values widen from literals
  to literals | `$binding` row-id references (ref-target checked) | the
  closed predicates `NOT_NULL` / `ANY`; `match: "exact"` additionally
  pins the full response key set (completeness enforced at `spec check`);
  `state` asserts what the request did to the WORLD — outbox event rows
  (`event`, `from: $fixture`, payload `fields` matched against the row)
  and per-table row-count deltas snapshot around the request (delta 0
  asserts rollback). Error-status bodies address the pinned `{"detail"}`
  envelope and are exempt from entity-field membership. The design tenet:
  input→output is the ONE test primitive; every future form (properties,
  boundary lattices, scenarios) is sugar that compiles down to the same
  `{given, input, expect}` triple.
- **Compiled import surface + reading discipline** (prompt kernel): the
  task header no longer invites the agent to read dependency sources for
  conventions. The compiler inlines the exact importable symbol slice
  (computed from the blueprint, per dependency set) and forbids reading
  `conformance/`, `tests/spec_oracle/`, `.spec/`, `.spec-input/`, and
  sibling routers — the clause table is the complete contract.

## 12. Addendum (2026-09-05, second batch): full in-loop coverage + the manifest gate

Oracle v2 completed its coverage matrix — no clause class is terminal-only
anymore:

- **auth node behavior**: seven triples (register exact-key-set without the
  hash, duplicate → 409, login token shape, wrong-password and
  unknown-identity asserting the IDENTICAL literal 401 body, me ±token);
  the runner seeds the principal via `needsPrincipal` without minting a
  token.
- **invariant probes**: rowCheck compiles a bounds-legal violating create
  (→ 409 + rollback count); crossRowCount direct-seeds a parent at its
  bound plus bound-many children and asserts the next API create 409s
  (counted router) and that tightening the bound below the live count 409s
  (bound router, skipped where bounds would 422 first). Guard/check trees
  gained string-neq/eq violation derivation with maxLength guards.
- **infra behavior**: cache/messaging/blob CONTRACTs embed their full
  declarations and the runner ports the terminal fake-client probes
  (in-memory isolation/single-flight, exact redis ex/prefix shapes, bypass
  vs fail-closed, envelope/broker semantics, kafka/rabbit/sqs call shapes,
  the full S3 sequence incl. presign Params/ExpiresIn). Verified green
  against the smoke run's REAL generated cache/blob modules and
  mutation-killed (redis TTL +1, presign TTL +1 both rejected).

**Test manifest (planned #27, landed)**: `manifest.ts` maps every clause
id to {inLoop, terminal} coverage derived from the ACTUAL compiled probe
labels — never naming conventions. `spec check` gates it:
`TEST_COVERAGE_MISSING` (error) for oracle clauses nothing covers,
`TEST_COVERAGE_TERMINAL_ONLY` (info) for clauses judged only at the
single-shot terminal. Dry-runs write `test-manifest.json`. All backend
examples currently pass with zero terminal-only clauses.
