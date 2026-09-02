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

