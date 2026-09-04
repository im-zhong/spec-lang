# Golden-rule results — measured

Machine-checked by `spec generate --shots 2` (Claude Code `claude-sonnet-4-5`
headless, uv + Python 3.13, macOS/arm64). Every project below generated
**two independent applications** from the same `.spec.ts`; each shot had to
pass the compiler-derived conformance suite, and both shots had to expose an
**identical normalized OpenAPI interface** (paths, methods, status codes,
path params).

## Runs (2026-09-01)

| Project | Shape | Shots | Repairs | Cost | Interface | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `examples/inventory` | 2 entities, no auth, 11 routes, `/api/v1` prefix, count endpoint | 2/2 conformant | 1 + 2 | $3.37 | identical | **repeatable** |
| `examples/cblog` | 3 entities, auth, two-level refs, 18 routes, all protected | 2/2 conformant | 0 + 0 | $3.52 | identical | **repeatable** |
| `examples/booking` | 3 entities, mixed public/protected, partial CRUD, datetime, count | 2/2 conformant | 0 + 1 | $3.69 | identical | **repeatable** |

Same behavior, different code — verified for `inventory`, where shot 1
named its DB module `app/database.py` and shot 2 named it `app/db.py`
(completely different `main.py` bytes), yet both pass the same suite and
expose the same interface.

## Divergences found & pinned (spec/compiler changes, never agent retries)

| # | Divergence / failure | Where it surfaced | Fix |
| --- | --- | --- | --- |
| 1 | `create_app(database_url=…)` interpreted as bare path or SQLAlchemy URL | inventory pilot | pinned `database.urlFormat: "sqlalchemy-url"`; suite passes `sqlite:///…` |
| 2 | Conformance helpers not importable from test modules | inventory pilot | suite split into `conformance/helpers.py` + explicit imports |
| 3 | Unique string fields got constant samples → second create 409'd inside the suite itself | inventory pilot | per-call unique samples; 409 contract now actually exercised |
| 4 | Python `True/False/None` vs JSON `true/false/null` in emitted assertions | inventory pilot | `pythonLiteral` renderer for defaults |
| 5 | Fields with defaults: sent-and-echoed vs omitted-and-defaulted | inventory pilot | pinned `serialization.createDefaults: "omittable-appliesDefault"` |
| 6 | `uv venv .venv` not idempotent across repair rounds → misleading "venv failed" repair prompts (one agent wrecked its workspace chasing it) | cblog run 2 | `uv venv .venv --clear` + quiet install |
| 7 | Duplicate-identity register test omitted `password` → 422 instead of 409 | cblog run 2 | suite generator emits the full register body |
| 8 | 30-min wall-clock budget too tight for slow-gateway first turns | cblog run 1 | runner budget 45 min |
| 9 | Repair agents could destroy workspaces | cblog run 2 | `rm` removed from the tool allowlist |
| 10 | **Consistent-but-wrong**: both frontend shots pixel-identical, yet the sidebar's Projects/Reports links were dead — the spec declared one screen while nav pointed at undeclared routes, and the oracle only tested `screens[0]`, never clicking nav | frontend-golden 2-shot run (2026-09-02) | **Golden rule extended: cross-shot equality is necessary, not sufficient.** Added `UI_NAV_TARGET_UNKNOWN` compile gate (nav href must equal a declared screen path); oracle now renders EVERY declared screen (per-screen `layout-N.png` pixel evidence), clicks every nav item and asserts the landed screen, and equality compares all per-screen captures |
| 11 | Agent model, effort, turn budget, and scheduler concurrency were not part of the immutable plan; four concurrent Claude containers also pressured the 4 GiB Docker VM and `blob` exited 137 | media-platform `media-platform-golden-20260903` | Require explicit `--model`, `--effort`, and `--max-turns`; fingerprint those values plus per-shot concurrency; run Claude in safe/no-persistence mode; lower default total concurrency to 2 |
| 12 | `models` installed inspection dependencies into repository-local `.pkg-tmp`, violating its exact file scope | media-platform `media-platform-golden-20260903` shot 1 | Every backend task prompt now requires all scratch files, temporary dependencies, virtualenvs, and caches under `/tmp`; regression asserts the rule is present |
| 13 | A transient SSH disconnect made a read-only dependency `git fetch` fail before the `messaging` agent ran | media-platform `media-platform-golden-20260903` shot 1 | Added three bounded retries only for idempotent remote reads (`fetch`/`ls-remote`), with a test that forces the first fetch to fail |
| 14 | After a shot was already nonconformant, the scheduler continued launching independent nodes that could no longer reach conformance | media-platform `media-platform-golden-20260903` shot 2 | GitHub generation now fail-fast: stop launching new work after the first failed result while allowing already-running siblings to finish safely |
| 15 | Claude's structured failure on stdout was discarded whenever stderr contained a warning, leaving only an unrelated telemetry message in the report | media-platform `media-platform-golden-20260903-v2` shot 2 | Process failures now retain bounded stderr **and** stdout; regression covers a structured stdout failure plus stderr warning |
| 16 | The blob oracle tested the in-memory adapter but only checked that `S3BlobStore` existed; the prompt also left the boto3 call surface and multipart threshold to the agent | media-platform `media-platform-golden-20260903-v2` review | Pinned `S3BlobStore(client)` and exact async boto3 operations, removed undefined multipart-threshold guidance (all declared maxima fit S3 PutObject), and added a fake-client behavior oracle |
| 17 | Broad infrastructure prompts produced 600–770 line blob/cache modules and long, unstable agent sessions | media-platform `media-platform-golden-20260903-v2` | Restricted blob/cache/messaging modules to their declared public APIs and injected clients; next run lowers pinned effort from high to medium |
| 18 | Cache prompt said `get(policy, key)` while the compiler oracle passed the declared policy **name**; v3 shot 1 generated an object-only API and shot 2 generated a name-compatible API. Cache and messaging provider classes were also not behavior-tested | media-platform `media-platform-golden-20260903-v3` contract audit | Pinned cache method arguments to declared name strings; pinned exact Redis/Kafka/RabbitMQ/SQS client calls, serialization, ordering/deduplication keys, and failure behavior; added fake-client provider oracles. Replaying the critical new cache probe rejected shot 1 with the predicted `AttributeError` and accepted shot 2 |
| 19 | Both database agents spent the entire 60-turn budget exploring unspecified settings/engine APIs and attempting shell probes rejected by the safe allowlist; neither produced a task commit | media-platform `media-platform-golden-20260903-v4` | Pinned the complete config/database public API, engine/session options, per-app dependency isolation, and app lifespan wiring. Prompts now explicitly describe the single allowed `uv run --no-project` probe form and forbid pip/venv/git/redirection/pipes/chained commands; the safe allowlist remains narrow |
| 20 | A transient GraphQL EOF from `gh pr create` failed shot 2 after its messaging commit was already pushed; an ambiguous response could also mean GitHub accepted the PR before the response was lost | media-platform `media-platform-golden-20260903-v5` | PR upsert now uses the immutable head branch as its idempotency key: after every create response (including failure), it performs bounded branch lookups before any retry. A fake CLI regression proves a server-accepted/EOF create is recovered with exactly one create call |
| 21 | Shot 2 completed `router-Webhook`, but publication failed after all three `git ls-remote` attempts lost the GitHub SSH connection on port 22 | media-platform `media-platform-golden-20260903-v6` | Temporary shot repositories now use GitHub's SSH endpoint on port 443; existing clones are identity-checked before their origin is normalized, so workflow-write permission is preserved without depending on outbound port 22 |
| 22 | The first port-22 mitigation used HTTPS, but the authenticated OAuth token lacked GitHub's `workflow` scope and bootstrap could not push `.github/workflows/spec-generation.yml` | media-platform `media-platform-golden-20260903-v7` | Use SSH-key authentication over `ssh.github.com:443` instead. A private-repository authentication/read probe passed before implementation; v7 stopped before any agent node ran |
| 23 | Shot 2's first conformance import failed because `router-Delivery` imported `DeclarativeBase` from top-level `sqlalchemy`; shot 1 independently chose no such import | media-platform `media-platform-golden-20260903-v6` resumed | Router prompts now pin model/base ownership and exact SQLAlchemy import modules: routers never define/import `Base` or `DeclarativeBase`, and a generic model-class helper uses `type[Any]` or no annotation |
| 24 | Auth routes were assigned to both `router-User` and `router-auth`; the app task either omitted the dedicated router or mounted duplicate paths, producing the wrong login error behavior | media-platform `media-platform-golden-20260903-v6` full-code audit | Planned: add explicit route ownership to the blueprint, reject multiple owners, exclude auth operations from generic entity routers, and compiler-generate the router registry |
| 25 | Every agent node used acceptance command `true`, so a missing `AssetOut.uploadedBy`, an extra `/api/v1/api-keys/count`, and the invalid SQLAlchemy import all received green task checks | media-platform `media-platform-golden-20260903-v6` full-code audit | Planned: add compiler-owned, single-judgment import/ABI/schema/route-manifest acceptance after every node; failure ends the shot and never starts a repair loop |
| 26 | The blob prompt specified a `BlobPolicy`-object API while the compiler oracle called the same API with policy name strings | media-platform `media-platform-golden-20260903-v6` shot 1 conformance | Planned: represent the exact module ABI in the blueprint and derive prompt, static checks, oracle, and behavior snapshot from that one object |
| 27 | Served caches, queues, messages, and blobs were declared but not bound to HTTP/lifecycle operations; several promised behaviors (retry/dead-letter, real stampede suppression, retention, production provider lifecycle) were not correctness-tested | media-platform `media-platform-golden-20260903-v6` spec/IR/oracle audit | Planned: typed operation bindings plus feature-to-assertion coverage; reject unresolved or untested served behavior at compile time |
| 28 | Failure evidence kept only a bounded log tail and the remote plan ref kept only `plan.json`; local `.spec` artifacts could also mix IR/manifest from one example with blueprint/DAG from another | media-platform `media-platform-golden-20260903-v6` evidence audit | Planned: atomic run-addressed bundles containing source, manifest, IR, blueprint, DAG, prompts, oracle, toolchain and full hashed logs, plus a failure-evidence ref and cross-shot semantic-input digest |

## Post-v6 design implementation (not a reroll)

The v6 result remains `golden-rule-invalid`; none of its generated code or
judgments changed. Before any new paid run, the compiler/harness now includes:

- Spec IR 0.3 first-class `spec.interface`, `spec.module`, and `spec.call`
  contracts with exact provider/caller linking and interface/module hashes;
- deterministic incremental invalidation in which changed interface providers
  and callers are regenerated concurrently, while unchanged modules are reused;
- executable composite FastAPI/React workspace lowering with disjoint module
  cwd/scopes, a shared frozen interface contract, HTTP provider-route checks,
  compiler-owned caller clients, and one combined conformance judgment;
- a fingerprinted, bounded per-node implementation/test/reviewer synthesis loop
  with isolated writer snapshots and read-only reviewer enforcement;
- non-vacuous per-node acceptance commands outside that loop, followed later by
  the unchanged single compiler-owned conformance judgment;
- explicit unique route ownership, keeping auth operations exclusively in
  `router:auth`;
- one machine-readable blob ABI whose `policy_name` string selector is consumed
  by blueprint, prompt, generated node tests, and conformance;
- a shot-independent semantic-input digest and an immutable `.spec-input`
  bundle containing source, manifest, IR, blueprint, DAG/prompts, verification,
  and oracle bytes.

This is deterministic/unit-tested design evidence only. It does not turn v6
green and is not a substitute for a fresh isolated golden-rule reroll.

Each fix made the *contract or harness* more precise; generation quality
improved accordingly (cblog's final run needed zero repairs).

## Correctness clause (the golden rule, complete form)

> Same spec → N shots that are (a) individually conformant, (b) mutually
> identical, **and (c) correct against the declared contract** — including
> that every navigation target, control, and state transition the spec
> declares actually exists and works. Identical-wrong output is a
> specification defect, not a pass. The oracle must encode (c), not just
> (a)+(b).

## Frontend runs

| Project | Shape | Shots | Repairs | Cost | Layout | Behavior | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `examples/frontend-golden` (1 screen, dead nav) | 1 screen, 13 components, 1 DAG task | 2/2 conformant | 0 + 0 | $0.75 | identical | identical | **consistent, WRONG → spec defect #10** (fixed, regenerated) |

## Media-platform runs (2026-09-03)

| Run | Repository topology | First-attempt conformance | Equality evidence | Verdict |
| --- | --- | --- | --- | --- |
| `media-platform-golden-20260903` | 2 private temporary GitHub repositories + 2 distinct local roots | 0/2; shot 1 reached a terminal report, shot 2 had already failed `cache`, `blob`, and `messaging` before it was intentionally stopped when the old scheduler began spending on unreachable routers | unavailable because neither shot reached the compiler-owned oracle | **failed; defects #11–#14 pinned, no generated code repaired** |
| `media-platform-golden-20260903-v2` | 2 new private temporary GitHub repositories + 2 new distinct local roots | 0/2; shot 2 failed `blob` and fail-fast skipped all remaining nodes; shot 1 published green project/blob/cache/database PR checks before the already-failed run was stopped | unavailable because both shots could no longer reach the oracle | **failed; defects #15–#17 pinned, no generated code repaired** |
| `media-platform-golden-20260903-v3` | 2 new private temporary GitHub repositories + 2 new distinct local roots | not reached; both shots passed project, blob, and cache task checks, then a contract audit proved shot 1's cache API incompatible with the compiler oracle before the remaining DAG was spent | unavailable; the run was intentionally stopped before downstream generation once nonconformance was proven by replay | **failed; defect #18 pinned, both repositories and generated commits preserved, no generated code repaired** |
| `media-platform-golden-20260903-v4` | 2 new private temporary GitHub repositories + 2 new distinct local roots | 0/2; both shots passed project, blob, and the newly pinned cache task, then independently exhausted 60 turns on database; fail-fast skipped every downstream node | unavailable because neither shot could reach conformance | **failed; defect #19 pinned, full stdout/stderr diagnostics and both repositories preserved, no generated code repaired** |
| `media-platform-golden-20260903-v5` | 2 new private temporary GitHub repositories + 2 new distinct local roots | not reached; both shots passed project/blob/cache/database and shot 1 also passed messaging, while shot 2's pushed messaging commit hit a transient `gh pr create` GraphQL EOF; the run was stopped before downstream spend | unavailable because shot 2 could not reach conformance | **failed on control-plane publication; defect #20 pinned, generated code untouched and both repositories preserved** |
| `media-platform-golden-20260903-v6` | 2 new private temporary GitHub repositories + 2 new distinct local roots; original immutable plans resumed over GitHub SSH port 443 after the publication interruption | 0/2; both completed all 20 agent nodes. Shot 1 ran 85 tests: 76 passed and 9 failed (duplicate auth ownership/wrong error, missing `AssetOut.uploadedBy`, blob ABI mismatch). Shot 2 failed the import gate on a top-level `sqlalchemy.DeclarativeBase` import. `containers` was skipped in both | unavailable because neither shot passed individual first-attempt conformance | **terminal conformance failure; defects #23–#28 recorded, full code and evidence preserved, no generated code repaired, and generation paused for design work** |
| `media-platform-golden-20260903-v7` | repository bootstrap stopped after creating shot 1; no second repository and no agent execution | not reached; HTTPS push of the compiler-owned workflow was rejected because the OAuth token lacks `workflow` scope | unavailable | **pre-execution transport experiment failed; defect #22 pinned and the bootstrap-only repository preserved** |

## Store-platform runs (2026-09-03/04) — first golden-rule exercise of the interface-composite design

Spec: `examples/store-platform/app.spec.ts` (87 lines). Three independent FastAPI
modules — `warehouse`, `orders`, `reporting` — with two interfaces used
exclusively between backend modules (`WarehouseApi` provided by warehouse and
consumed by orders + reporting; `OrderApi` provided by orders and consumed by
reporting), demonstrating that interfaces bind any module pair, not only
frontend/backend. Deterministic gates were green before every run (143 unit
tests, `spec check`, `--dry-run`: 3 modules / 2 interfaces / 18 DAG tasks).
Target size ~1000 generated lines. Every run used fresh temporary GitHub
repositories and distinct local roots; all repositories and evidence are
preserved under `.spec/generation/store-platform-golden-20260903-*` and
`im-zhong/spec-store-platform-*`.

| Run | Outcome | Classification |
| --- | --- | --- |
| `…-20260903-v1` | both shots failed the first agent task before claude started: the per-exec credential copy (`cp -R src/. dst/`) is not re-runnable and the old design re-ran bootstrap on every exec | **checkpoint-resumable; defect #29 pinned; zero agent spend** |
| `…-20260903-v2` | six concurrent boots each copied 785 MB of host `~/.claude` (22 s solo, >60 s contended): three initialize timeouts, remaining writers SIGKILLed (exit 137) under memory/I/O pressure; one resume attempt also misclassified a transient SSH failure as "repository does not exist" | **checkpoint-resumable; defects #30/#31 pinned; superseded by fresh run ids** |
| `…-20260903-v3` | both shots lost all four project tasks at the loop write-back audit: interpreter artifacts (`app/__pycache__/*.pyc`) flagged as scope violations, and the tests agent placed its file inconsistently (`spec_tasks/…` vs `tests/spec_tasks/…`) because the prompt carried two contradictory scope statements | **golden-rule-invalid at node level; defects #32/#33 pinned; generated code untouched** |
| `…-20260903-v4` | shot-1 orders failed identically to v3 despite prompt disambiguation (shot-2 placed the file correctly — cross-shot divergence); reporting was stopped by the operator to flush diagnostics | **defect #33 confirmed prose-only fixes insufficient → mechanical scaffold fix; superseded** |
| `…-20260903-v5` | both shots' writers completed (symmetric 416/406-line test files, pyproject in place) but every reviewer returned "no structured verdict"; reviewer stdout was discarded so the cause was unverifiable | **defect #34 pinned (judge parsing + diagnostics retention); superseded** |
| `…-20260903-v6` | writers on both shots died mid-round with `API Error: Request rejected (429) · 已达到 5 小时使用上限` (`api_error_status=429`, ~$0.96/$0.59 per exec); the machine then slept overnight. Retrospectively v5's verdict failures were most likely the same quota exhaustion | **control-plane (external quota); window reset 2026-09-04 02:42:48; superseded** |
| `…-20260903-v7` | launched under `caffeinate` with the full fix set; both seeds pushed, four project agents in flight, zero failures — stopped by the operator at 09:59 before any judgment | **operator-stopped, not a judgment; repositories and checkpoints preserved** |

Defects pinned (compiler/harness changes only, never agent retries):

| # | Symptom | Fix |
| --- | --- | --- |
| 29 | `cp -R src/. dst/` fails on an already-populated credential tree; old design re-ran bootstrap on every exec | bootstrap runs once per container via `initializationCommand`; copy is an idempotent `tar … --skip-old-files` extraction |
| 30 | 785 MB credential copy per container; 60 s initialize timeout under concurrent boot I/O; writers SIGKILLed | exclude `plugins/` + `projects/` (785 MB → 8.3 MB, 22 s → ~2 s); initialize timeout 300 s |
| 31 | resume misread a transient `gh`/SSH failure as "temporary repository does not exist" | `repositoryExists` retries transport errors and only treats GitHub 404 as absence, then fails loud |
| 32 | scope audit flagged interpreter artifacts as agent writes | `PYTHONDONTWRITEBYTECODE=1` in every container + audit ignores `__pycache__/`, `*.pyc`, `.pytest_cache/` |
| 33 | tests-role path was prose-defined and contradicted the embedded contract, producing cross-shot divergence | compiler materializes a non-vacuous test scaffold at the exact owned path (`tests/spec_tasks/test_<task>.py`) for all 18 loop tasks; prompt says edit in place; empty scaffold keeps acceptance failing (exit 5) until real tests exist |
| 34 | reviewer verdict parsing accepted only bare JSON and discarded reviewer stdout on failure | mechanical extraction of the `approved` object (tolerates fences/prose), prompt demands exactly one JSON object, bounded reviewer output retained in the diagnostic |

Status: **golden rule not yet judged** for this spec. Mid-run evidence is
encouraging (symmetric writer output across shots, all fixes unit-tested), but
no run has reached the combined conformance + interfaceEqual + behaviorEqual
judgment. Next step is one uninterrupted run in a fresh quota window —
`spec generate examples/store-platform/app.spec.ts --shots 2 … --concurrency 4`
(resume semantics preferred for any control-plane interruption).

Shot 1's immutable plan and complete report remain under
`.spec/generation/media-platform-golden-20260903-shot-1/`; both remote
repositories and their published commits/PR checks were preserved. Shot 2 has
an immutable plan and published successful task commits but no final local
report because the pre-fix harness only wrote a report after all runnable
nodes completed. It was stopped after the failure was already decisive to
avoid spending on eleven routers that could not unlock `app` or conformance.

## Design change (2026-09-04): clause-driven generation — no agent spend

Between-runs design change replacing the three-role loop. Full record:
`docs/clause-driven-generation.md`.

| Change | Rationale |
| --- | --- |
| Node contracts became machine **clause tables** (`ContractClause {id, statement, kind, verification, level}`); prompt kernel, node oracle, reviewer checklist, and plan fingerprint all project from one table | the old "frozen contract" was the dev's prose task brief reused verbatim as the tests agent's input; requirements were prose with no ids, so coverage was unauditable (the RTM gap) |
| **Tests agent deleted**; per-node tests are compiler-generated (`tests/spec_oracle/`, contract-embedding style) and materialized with the seed — frozen from round 1, agent-unwritable; `reviewer.commands` and `acceptanceCommands` point at them | the judging tests were LLM-invented per shot per round: the judgment itself contained unpinned decisions (defect #33's root cause). Node judgment is now deterministic; the GitHub workflow's clean-container re-run is compiler-owned end to end |
| Loop schema `spec-agent-task-loop/0.1 → 0.2`: single implementation writer (no snapshot/merge machinery), checks `generation/loop/<n>/{implementation,review}`, per-round cost one writer + one reviewer (~⅓ fewer execs) | parallel blind test-writing existed only to translate prose into pytest; with clause tables the compiler does that translation deterministically |
| **Challenge protocol** added: a writer that concludes the contract is defective answers `{"challenge":{"clause":…,"reason":…}}`; docker.ts detects it and terminates with `SPEC_CONTRACT_CHALLENGED` — a spec defect, never a retry | agents previously had to improvise around contract defects; improvisation is an unpinned decision. Now the only correct response to a defect is to reject it |
| Schema class names pinned (`<E>Create/Update/Out`); router/auth/cache/messaging/blob export surfaces and adapter call shapes are clauses | the oracle needs deterministic symbols; every pin traces to a clause id |
| `AGENT_EXECUTION_LOOP_CLAUSE_INVALID` validation; `lint` verification reserved (zero clauses v1) | clause tables are plan data and must validate like the rest of the plan |

Verification: deterministic gates only (`pnpm build && npx vitest run`
158 passed; double dry-runs byte-identical for booking, media-platform,
store-platform, interface-workspace, frontend-golden; oracle files
py_compile-clean across all examples). The paused v7 run is permanently
non-resumable across this boundary (prompt semantics changed) and is
superseded. Next golden-rule attempt under the new loop: booking smoke,
then store-platform.
