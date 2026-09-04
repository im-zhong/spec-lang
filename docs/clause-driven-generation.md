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
