# TODO — phased backlog

Status record of everything deliberately deferred, with the reason it was
cut and what finishing it involves. Ordered by recommended sequence within
each group. Design constitution for all test work: **input→output is the
ONE test primitive** — every future form compiles down to the same
`{given, input, expect}` triple (see `docs/clause-driven-generation.md`
§11); agents never author test bytes.

## 1. Test vocabulary — execution coverage (oracle v2 leftovers)

- [x] **`router:auth` behavior probes.** (2026-09-05) Seven triples:
  register (exact key set, never the hash), duplicate identity → 409,
  login success → token shape, wrong password and unknown identity → the
  IDENTICAL literal 401 body (no enumeration), `me` with/without token.
  Runner seeds the principal on `needsPrincipal` without a token.
- [x] **Invariant cross-row world probes in node oracles.** (2026-09-05)
  rowCheck: create with a bounds-legal violating value → 409 + rollback
  count; crossRowCount: direct-seed a parent at its bound plus bound-many
  children, the next API create → 409 (counted router), and tightening the
  bound below the live count → 409 (bound router, skipped when bounds
  would 422 first). Verified compiled for smoke (venue rowCheck + booking
  no-overbooking); real-run pending the resumed smoke generation.
- [x] **Infra adapter behavior probes in node oracles.** (2026-09-05)
  cache/messaging/blob CONTRACTs embed full declarations; the runner
  ports the terminal fake-client probes (in-memory semantics, exact redis
  ex/prefix calls, failure modes, envelope/broker semantics, provider
  call shapes, S3 sequence incl. presign Params/ExpiresIn). Verified
  green against the smoke run's real generated cache/blob modules and
  mutation-killed (redis TTL +1, presign TTL +1).

## 0.5 Prompt protocol hardening

- [ ] **Challenge-trigger clarity.** v6's app node burned all 3 loop rounds
  on a clause only satisfiable by editing a compiler-owned DO-NOT-EDIT file
  outside its scope — the correct move was a round-1 `{"challenge":...}`.
  The kernel should state explicitly: "a clause that can only be satisfied
  by editing a DO-NOT-EDIT or out-of-scope file is a challenge, not a
  workaround."

## 2. Test vocabulary — input-side language (sugar over the primitive)

- [ ] **`sample(n, seed)` = fuzz/property.** Requires the runtime sampler
  change: today's samples are TS-time baked literals; properties need the
  field-grammar sampler LOWERED into generated Python (a mini-sampler plus
  the rule evaluator for echo/defaults assertions). Seed defaults to the
  clause-id hash (never author-visible); `samples` bounded.
- [ ] **`probe` lattice vocabulary** for cases the compiler cannot derive
  (bounds lattices are already rule-derived — this is the author-declared
  escape hatch). Wait for a real spec to need it.
- [ ] **`scenario` composition sugar.** Steps of examples + bindings,
  compiled to triples. Open semantics: intermediate-failure attribution,
  per-step auth inheritance. Overlaps existing transition-chain tests;
  await a real demand.
- [ ] **`exact` mode beyond crud create/update/get** (transitions, auth op
  responses) and dotted `$binding.field` references if a spec needs them.
- [ ] **`lint` verification kind** remains reserved for real lint rules.

## 3. Coverage as a compile gate

- [x] **Test manifest.** (2026-09-05) `packages/fastapi/src/manifest.ts`
  derives clause-id → {inLoop, terminal} from the ACTUAL compiled probe
  labels (never naming conventions); `spec check` gates it
  (TEST_COVERAGE_MISSING = error, TEST_COVERAGE_TERMINAL_ONLY = info) and
  dry-runs write `test-manifest.json`. All backend examples pass with
  zero terminal-only clauses after §1. This lands golden-rule-results
  planned item #27.

## 4. Agent-surface shrink (static maximization)

- [x] **Walking-skeleton topology** (2026-09-05): the app node lands as
  STEP TWO (deps project only), the registry became
  detection-based (pinned order, import-on-existence), and infra adapters
  wire by detection. The app boots first and every router landing grows
  the live route set (pairs with `spec preview`); strict equality stays
  terminal and the app oracle is snapshot-invariant.
- [ ] **Compiled nodes (`mode: "compiled" | "agent"` in the DAG).** project,
  models, schemas, database, security, app-skeleton are zero-freedom — their oracles
  are byte pins — so lower them as seed materialization with no loop, no
  reviewer, no agent exec. Keep the materialization commit + PR for the
  evidence chain. Their per-shot oracles become monorepo lowering
  self-tests. Expected effect: ~9 agent nodes → ~3 routers per booking shot.
- [x] **Routers stay agent** as the pilot of remaining agent surface
  (guard/effects translation) — confirmed by four smoke runs (v3–v7):
  every router node passed its behavior triple oracle on the first
  attempt. The follow-up (compile check-trees to SQL) stays open under
  "Compiled nodes" above once the vocabulary proves itself further.
- [ ] **Frontend (react) treatment**: same triple primitive for the single
  frontend task + the oracle-v2 equivalent (behavior.json already exists;
  unify vocabulary). Currently clauses+oracle exist (pins/files/import/
  screen-path), examples do not.

## 6. Monitor & preview platform (found while dogfooding, 2026-09-05)

- [ ] **App-oracle adapter-probe blind spot.** v7 app R1 passed the
  skeleton-state oracle with WRONG adapter symbol names (probed
  `InMemoryCache` vs pinned `InMemoryCacheBackend`) — the mismatch only
  detonates after cache/messaging land; the REVIEWER caught it by
  cross-checking dag.json. Fix: the app oracle should materialize minimal
  fake `app.cache`/`app.messaging`/`app.blob` modules into a temp dir and
  verify detection wiring actually constructs the pinned symbols.
- [ ] **Process-protocol skew during live runs.** Every telemetry/emission
  change (partial flag, full text, usage events) only applies to processes
  spawned AFTER a rebuild — running generators keep old semantics for
  hours. Options: agent command reads protocol version from env;
  or accept skew and make the monitor version-aware (it already
 heuristically folds unmarked runs; usage/rate simply absent for old runs).
- [ ] **Generated frontend needs gates.** The dashboard was generated as
  an inline template string and shipped five first-draft bugs (selector
  never matching, `const` spliced into an expression chain, UTC rendered
  raw, silent caps, scroll reset on re-render). Gates now: `node --check`
  on the extracted script; missing: a real-DOM smoke test (jsdom) and a
  "selector hits" assertion for every class the script queries.
- [ ] **Monitor state should be incremental (`?since=`)** — today every
  poll re-reads and re-sends the full event file (~1.5 MB at 90 min;
  fine on loopback, wrong for remote/long runs).
- [ ] **`--effort low` A/B.** Thinking is 68–85% of node time on big
  infra nodes; one low-effort shot vs medium would measure repair-round
  risk against wall-clock savings.
- [ ] **SSE instead of 2s polling** for the activity feed (latency + load).

## 0. Known open defects (control plane)

- [ ] **Local `--resume` rebuilds a plan whose root base references the
  advanced main** and correctly trips the immutable-plan check — local
  resume needs the base pinned to the run's bootstrap root (the plan-read
  64 MiB bound fix landed 2026-09-05; the base derivation did not).

## 5. Validation runs (spend money deliberately)

- [x] **First paid validation of the clause-driven loop (single shot)**:
  smoke v3 (13/13 nodes first-try, zero repair rounds; terminal
  conformance failures were compiler test-generator defects #29–33, all
  fixed and replay-verified 38/38) and v7 (walking skeleton, registry
  fix #34, live telemetry).
- [ ] **Multi-shot golden-rule validation**: booking `--shots 2`, then the
  anti-overfit trio (cblog/inventory/booking), then a fresh store-platform
  golden run — cross-shot interface/behavior equality is the part
  single-shot smokes cannot prove. The old v7 paused run is permanently
  non-resumable (fingerprint boundary); regenerate the handbook via
  `scripts/export-agent-prompts.mjs` when the new run is planned.
- [x] Re-run `examples/bounds` generation — superseded: `examples/smoke`
  (v3–v7) exercises every §1 probe (auth, invariant, infra) plus the
  walking skeleton, examples vocabulary, and preview in real generation.
