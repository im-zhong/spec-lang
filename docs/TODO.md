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

- [x] **Walking-skeleton topology** (2026-09-05): the app node moved from
  sink to early skeleton (deps models+database only), the registry became
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
- [ ] **Routers stay agent** as the pilot of remaining agent surface
  (guard/effects translation). Later: compile check-trees to SQL once the
  vocabulary proves itself.
- [ ] **Frontend (react) treatment**: same triple primitive for the single
  frontend task + the oracle-v2 equivalent (behavior.json already exists;
  unify vocabulary). Currently clauses+oracle exist (pins/files/import/
  screen-path), examples do not.

## 5. Validation runs (spend money deliberately)

- [ ] **First paid validation of the clause-driven loop**: booking
  `--shots 2` smoke, then the anti-overfit trio, then a fresh store-platform
  golden run under the new loop (the v7 paused run is permanently
  non-resumable — fingerprint boundary — and its prompts.md archive is
  superseded; regenerate the handbook via `scripts/export-agent-prompts.mjs`
  when the new run is planned).
- [ ] Re-run `examples/bounds` generation once §1 auth probes land so the
  fixture's own node oracle exercises them.
