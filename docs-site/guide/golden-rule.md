# The golden rule

> The spec is the program. Generate the same specification several times
> and the software must behave the same — same interface, same APIs, same
> features, same responses.

Specification programming only replaces a programming language if the
specification alone determines observable behavior. Anything the coding
agent "decides" is a behavior the specification failed to pin.

## How it is enforced

`spec generate` machine-checks repeatability in four layers:

1. **Deterministic planning** — the blueprint, the agent prompts and the
   conformance suite are pure functions of the Spec IR. Same spec in,
   byte-identical plan out (verified by tests).
2. **A compiler-owned conformance suite** — a pytest suite derived from
   the blueprint is dropped into every generated workspace. It asserts
   the exact route set (strict OpenAPI path/method equality), success
   status codes, response key sets and values, exact error bodies, the
   auth flow, list ordering, defaults and reference semantics.
3. **N independent shots** — each generation is a fresh workspace with an
   independent agent run. Every shot must pass the *same* suite.
4. **Interface equality** — every shot's normalized OpenAPI document
   (paths, methods, statuses, path params) must be identical.

## When generation diverges

A divergence is a bug in the *specification language or the compiler*, by
definition. The remedy is always to pin more of the contract in the
blueprint — never to hope the agent complies next time. During development
of `@spec/fastapi`, exactly this happened three times:

| Divergence | Fix (in the compiler) |
| --- | --- |
| Agents interpreted `create_app(database_url=…)` as a bare path or a SQLAlchemy URL | pinned `urlFormat: "sqlalchemy-url"` and made the suite pass `sqlite:///…` |
| Response defaults: one shot echoed sent values, another applied declared defaults | pinned `createDefaults: "omittable-appliesDefault"` — defaulted fields are omittable and the declared default applies |
| Unique string fields collided across test rows | suite samples became per-call unique, pinning the 409 `Already exists` behavior |

## What is deliberately NOT pinned

The agent keeps full freedom over everything unobservable: code style,
file organization inside `app/`, library versions within constraints,
function names, database internals. The contract pins the interface and
behavior; the implementation remains the agent's craft.
