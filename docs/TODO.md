# TODO — phased backlog

Status record of everything deliberately deferred, with the reason it was
cut and what finishing it involves. Ordered by recommended sequence within
each group. Design constitution for all test work: **input→output is the
ONE test primitive** — every future form compiles down to the same
`{given, input, expect}` triple (see `docs/clause-driven-generation.md`
§11); agents never author test bytes.

## 1. Test vocabulary — execution coverage (oracle v2 leftovers)

- [ ] **`router:auth` behavior probes.** The auth node still gets shape
  checks only. Probes are principal-centric with a KNOWN password (the
  `behavior.auth` runtime-hash machinery already exists): register → 201
  (row, never the hash), duplicate identity → 409, login success → token
  shape, wrong password vs unknown identity → **byte-identical 401** (no
  user enumeration), `me` with/without token. ~80 lines of compiler code
  reusing the triple interpreter.
- [ ] **Invariant cross-row world probes in node oracles.** Invariants are
  still judged only at terminal conformance. Node-level needs
  direct-seeded minimally violating worlds derived from the check tree
  (`conformance.ts` already derives them API-side; port to direct inserts):
  `rowCheck` → create with violating field values → 409; `crossRowCount` →
  seed a bound parent (capacity N), create N+1 children, the (N+1)th must
  409. Handles the dual-node fan-in: violating create on the counted
  router, bound-tightening update on the bound router.
- [ ] **Infra adapter behavior probes in node oracles.** cache/messaging/
  blob nodes get shape checks in-loop; the fake-client behavior probes
  (FakeRedis/FakeKafka/FakeRabbit/FakeSQS/FakeS3) run only terminally.
  Port those probes into the node CONTRACTs (function-level triples
  against the module directly — no throwaway app needed).

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

- [ ] **Test manifest.** Compiler emits contract-element → covering-clause
  ids; `spec check` rejects declared behavior with no decidable test
  (golden-rule-results planned item #27). Grows naturally as §1/§2 land.

## 4. Agent-surface shrink (static maximization)

- [ ] **Compiled nodes (`mode: "compiled" | "agent"` in the DAG).** project,
  models, schemas, database, security, app are zero-freedom — their oracles
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
