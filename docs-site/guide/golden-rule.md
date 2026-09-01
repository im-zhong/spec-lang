# The golden rule

> The spec is the program. Generate the same specification several times
> and the software must behave the same — same interface, same APIs, same
> features, same responses — **on the first attempt, with no repair**.

Specification programming only replaces a programming language if the
specification alone determines observable behavior. Anything the coding
agent "decides" is a behavior the specification failed to pin.

## How it is enforced

`spec generate` machine-checks repeatability in four layers:

1. **Deterministic planning** — the blueprint, the generation DAG, the
   per-task prompts and the conformance suite are pure functions of the
   Spec IR. Same spec in, byte-identical plan out (verified by tests).
2. **A compiler-owned runtime conformance suite** — a pytest suite derived
   from the blueprint is dropped into every generated workspace. It starts
   the generated FastAPI application with `TestClient` and a fresh SQLite
   database, sends real HTTP requests, and asserts exact route sets, status
   codes, response bodies, auth, CRUD state changes, list ordering, defaults,
   references, lifecycle transitions, guards, effects and invariants.
3. **N independent shots, first-attempt conformance** — each generation
   is a fresh workspace executing the full generation DAG. Every shot
   must pass the *same* suite **on its first and only verification
   attempt**.
4. **Interface equality** — every shot's normalized OpenAPI document
   (paths, methods, statuses, path params) must be identical.

## What “behaviorally identical” means today

The current verdict is the conjunction of two independent checks:

```text
every shot satisfies the same deterministic functional oracle
AND
every shot exposes the same normalized OpenAPI interface
```

This is more than an OpenAPI comparison. The conformance suite checks real
responses and state transitions in each generated application. It is also a
precise boundary: the harness does not yet replay one shared request trace
against two live shots and compare every response, database row and outbox
event directly. Passing the same oracle proves equality over the contract's
generated test surface, not exhaustive observational equivalence for every
possible request sequence.

## The no-repair policy

There is no repair loop, and that is deliberate. Patching a generated
shot until it passes would measure *how good the patcher is*, not how
well the specification pins behavior. The protocol is:

```
generate N shots → verify once each
  all pass + identical interfaces   → golden rule satisfied
  any failure                       → the spec/blueprint is under-pinned
                                      fix the CONTRACT, regenerate all N
```

A failing shot reports `GENERATION_NONCONFORMANT` with the failing
command output — read as a specification defect, never as an agent retry
request. During development this discipline caught real contract gaps:

| Divergence | Fix (in the compiler, never in the shots) |
| --- | --- |
| `create_app(database_url=…)` read as bare path vs SQLAlchemy URL | pinned `urlFormat: "sqlalchemy-url"` |
| Response defaults: echoed sent values vs applied declared defaults | pinned `createDefaults: "omittable-appliesDefault"` |
| Unique string fields collided across test rows | per-call unique samples; 409 pinned |
| `list` scope: one shot excluded the requesting principal, another listed all rows | pinned `listScope: "allRows"` + suite assertions, then regenerated all shots |

The last row is instructive: the two shots disagreed because the blueprint
was silent. Repairing one output would have hidden the defect. The contract
was made explicit and every shot regenerated, which is why `listScope` now
exists.

## Latest measured run

On 2026-09-01, Claude Code configured with `deepseek-v4-flash[1m]`
generated two cblog shots and two Booking shots:

| Project | Functional result per shot | Cross-shot interface |
| --- | --- | --- |
| cblog | `28 passed` / `28 passed` | identical |
| Booking | `24 passed` / `24 passed` | identical |

All four shots used one conformance attempt and zero repairs. The
[source walkthrough](/deep-dive/source-walkthrough) traces that run down to
the evaluator, behavior nodes, DAG tasks and verification commands.

## What is deliberately NOT pinned

The agent keeps freedom over unobservable implementation choices: code style,
local helper functions and internal query structure. File ownership is
constrained by DAG scopes, and runtime/development dependency versions are
exactly pinned by the target stack. The contract pins interface and behavior;
the implementation remains the agent's craft.
