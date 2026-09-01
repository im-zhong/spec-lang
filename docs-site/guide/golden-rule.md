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
2. **A compiler-owned conformance suite** — a pytest suite derived from
   the blueprint is dropped into every generated workspace. It asserts
   the exact route set (strict OpenAPI path/method equality), success
   status codes, response key sets and values, exact error bodies, the
   auth flow, list scope and ordering, defaults and reference semantics.
3. **N independent shots, first-attempt conformance** — each generation
   is a fresh workspace executing the full generation DAG. Every shot
   must pass the *same* suite **on its first and only verification
   attempt**.
4. **Interface equality** — every shot's normalized OpenAPI document
   (paths, methods, statuses, path params) must be identical.

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
| `list` scope: one shot excluded the requesting principal, another listed all rows | pinned `listScope: "allRows"` + suite assertions; the oracle forced convergence, and the pin removed the ambiguity for good |

The last row is instructive: the two shots disagreed *because the
blueprint was silent*. The conformance suite still forced them to the
same observable behavior — but the correct response was to make the
contract explicit, which is why `listScope` now exists.

## What is deliberately NOT pinned

The agent keeps full freedom over everything unobservable: code style,
file organization inside `app/`, library versions within constraints,
function names, database internals. The contract pins the interface and
behavior; the implementation remains the agent's craft.
