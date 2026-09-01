# Behavior Model — Design Plan

Status: **all phases implemented** (2026-09-01):
- Phase 1 — `field.enum`, `lifecycle`/`transition`, §5 validators, §6
  lowering (action routes, atomic guarded updates, pinned 409), §7
  conformance matrix.
- Phase 2 — `invariant` + the `expr` vocabulary (`field`/`const`/
  `countOf`/comparisons/`both`), shape-restricted to row checks and
  countOf upper bounds (the SQL-litmus-admissible fragment), §5
  validators, lowering to transactional re-checks with the pinned
  `409 {"detail": "Invariant violated"}`, and conformance via minimally
  violating worlds.
- Phase 3 — transition **guards** (incl. the `request.time()` runtime
  term: the spec pins the comparison, never a timestamp) and **effects**:
  `effect.set` assignments plus `effect.emit` writing to the generated
  `events` outbox table in-transaction, with the columns pinned to
  (id, event, payload JSON, created_at) and conformance reading the
  outbox through the workspace database to assert exact payloads.
See `docs-site/guide/rest-resources.md` § "Lifecycles" (incl. "Guards and
effects") and § "Invariants" for the shipped surface.

This document specifies how behavioral semantics —
*what an API does*, not just *what it looks like* — enters the specification
language, and why the chosen constructs are the right ones.

## 1. The gap

Today the IR pins **shape** but not **behavior**:

- `entity` + `field` pin the data model;
- `crud` pins which endpoints exist (`packages/web/src/crud.ts`);
- `count()` pins one custom route's semantics exactly (`method: "GET"`,
  `operation: "count"`, `200 {"count": <int>}`) — the precedent this plan
  generalizes.

Anything behavioral beyond that — "a confirmed booking cannot be deleted",
"a venue cannot be overbooked", "cancelling emits an event" — has exactly one
place to live today: **prose in the generation prompt**. Prose is re-interpreted
on every generation shot. That is the drift the golden rule exists to eliminate:
behavior described in prose is a free variable the agent re-rolls; behavior
described as data is a pinned contract.

The plan: add behavioral vocabulary to the spec language as **pure data**,
statically validated, mechanically lowered, and mechanically tested — with zero
interpretive discretion left to the agent.

## 2. Behavior is three facets, not one thing

There is no single "best" behavior-description mechanism, because behavior is
not one thing. It has three orthogonal facets:

| Facet | Question | Mechanism | Status |
| --- | --- | --- | --- |
| **Point** (one request) | Is this input valid? What exactly comes back? | pinned operation contracts (validation, response shape, status table) | partially exists (`crud`, `count`) |
| **Line** (across requests) | Which operations are legal **when**? What changes? | **lifecycle** (state machine) | missing |
| **Plane** (globally, always) | What must hold across entities at all times? | **invariant** | missing |

A fourth concern — *what else happens* (side causes) — is not a facet of its own
but a property of operations, and gets its own closed vocabulary: **effects**.

### Why these mechanisms and not the alternatives

The decision criterion is not expressiveness. It is **who interprets the
behavior**: a construct is good if the *compiler* lowers it into mechanical
artifacts (SQL, status tables, generated tests) and the agent only writes
plumbing; a construct is bad if the *agent* must read it and faithfully
implement it, because every shot re-interprets it.

| Approach | Verdict | Reason |
| --- | --- | --- |
| Pre/postconditions (DbC, OCL, JML) | **absorbed, restricted** | The semantic superset — a transition *is* `pre: status ∈ from`, `post: status' = to`. Arbitrary predicates are undecidable and agent-interpreted; we keep only the decidable, SQL-lowerable fragment. |
| State machine (FSM) | **adopted** (lifecycle) | Everything decidable (reachability, duplicates); lowers to action endpoints + atomic guarded updates + `409`; conformance matrix is mechanically generable. |
| Invariants (Alloy/OCL style) | **adopted** (invariant) | The only natural expression of cross-entity truth; lowers to DB constraints / transactional re-checks. |
| Scenarios / examples (BDD) | **absorbed** (conformance layer) | The strongest *pin at points*, but no universal claim ("**only** these transitions"). Generated tests, not primary semantics. |
| Event sourcing | **benefits only** (outbox) | An implementation architecture, not description vocabulary. `effect.emit` + an events table captures the audit benefit without the architecture. |
| Temporal logic (LTL/CTL) | rejected | Liveness/protocol properties need a state space and time semantics; agents misread them; synchronous REST gains nothing. |
| Rule systems (datalog, production rules) | rejected | Rule conflict / firing order is nondeterminism — directly violates the golden rule. |
| BPMN / Petri nets / process calculi | rejected | Multi-party orchestration; static analysis gets hard, agent comprehension drops; wrong scale for single-service backends. |
| Prose in the prompt | baseline to eliminate | The current fallback; everything above exists to shrink it. |

### The litmus test for vocabulary

One rule governs every expression that may appear in a guard, invariant, or
effect:

> **An expression enters the vocabulary only if it lowers to a single SQL
> statement.**

If the compiler can lower it, the agent cannot misread it. If it cannot, it is
not vocabulary — it is prose wearing a syntax tree.

### A counterexample that proves the facets must stay separate

"Venue is full" — model it as an FSM state (`available → full`) and you get
sync bugs: two concurrent bookings each see `available`, both transition, and
the stored state drifts from the real count. Model it as an invariant
(`count(bookings, venue) ≤ capacity`) and "full" is a derived fact with no
state to drift; the database arbitrates concurrency for free. Forcing one
facet's construct onto the other facet's problem produces the wrong model.

## 3. The unified model: one kernel, three projections

The three additions are not three bolted-together features. They share one
kernel. Every mutating operation — a lifecycle transition, `create`, `update`,
`delete` — is uniformly:

```
operation {
  target:     entity
  guard:      ExprTree          // state predicate in the closed vocabulary
  updates:    [Assignment]      // field assignments
  effects:    [Effect]          // set / create / delete / emit, declared order
  invariants: [InvariantRef]    // compiler auto-injects those touching the entity
  outcomes:   StatusTable       // every failure mode → pinned status code
}
```

Execution semantics in generated backends (pinned, uniform):

```
BEGIN
  row = UPDATE ... WHERE id = :id AND <guard> RETURNING *   -- atomic
  if rowcount = 0        → <pinned guard-failure response>
  apply updates, effects (same transaction, declared order)
  re-check invariants    → <pinned invariant-failure response>
COMMIT
```

`lifecycle` is the kernel viewed as a graph (decidable analyses apply);
`invariant` is the kernel's global constraint set; `effect` is the kernel's
causal tail. Same data, three authoring views.

### Expression vocabulary (all data, never code)

- field access, constants;
- `request.time` — a **runtime** term (evaluated per request, deterministic
  semantics). This is deliberately distinct from compile-time `Date.now()`,
  which `SPEC_FORBIDDEN_ACCESS` rejects: the spec pins *that* the comparison
  happens against request receipt time; no timestamp is baked into the IR;
- `request.principal` (auth identity);
- `count(ref, filter)` — cardinality across a `field.ref` edge;
- comparisons (`= ≠ < ≤ in`) and `and / or / not`.

Every term resolves to a real node or is rejected at compile time. Every term
lowers to SQL (`WHERE`, `CHECK`, subquery). That is what makes the analyses of
§5 decidable and the lowering of §6 mechanical.

## 4. DSL surface (booking example, end to end)

No callbacks, no closures — object/tree arguments only, matching the
statically-evaluated expression subset and the existing builder style.

```ts
import { entity, field, crud, count,
         lifecycle, transition, invariant, effect, expr } from "@spec/web"

const Booking = entity("Booking", {
  id: field.uuid(),
  user: field.ref("User"),
  venue: field.ref("Venue"),
  startsAt: field.datetime(),
  status: field.enum("pending", "confirmed", "cancelled"),
})

// LINE — lifecycle: transitions are operations
const BookingFlow = lifecycle(Booking, {
  field: "status",
  initial: "pending",
  transitions: [
    transition("confirm", {
      from: ["pending"], to: "confirmed",
      guard: expr.field("startsAt").gt(expr.request.time()),
      effects: [effect.emit("booking.confirmed", ["id", "venue", "startsAt"])],
    }),
    transition("cancel", {
      from: ["pending", "confirmed"], to: "cancelled",
      effects: [effect.set("cancelledAt", expr.request.time())],
    }),
  ],
})

// PLANE — invariant: "full" is derived, never stored
const NoOverbooking = invariant("no-overbooking", {
  on: Venue,
  check: expr.countOf(Booking, { venue: "self" }).lte(expr.field("capacity")),
})

const Bookings = crud(Booking, { methods: ["list", "get", "create", "delete"] })
```

Exact builder signatures are illustrative; the invariants on them are not:

- `lifecycle.field` must name an `enum` field of the target entity;
- every `from`/`to` state must be a member of that enum;
- an entity's lifecycle-bound field is immutable through generic `crud`
  `update` — state changes only through transitions, and the compiler enforces
  it (§5).

## 5. Static validation (layer 4, `defineValidator`)

Expressiveness was traded for decidability; this is what the trade buys. All
checks run as package validators, in the style of `packages/web/src/validators.ts`:

| Code | Severity | Meaning |
| --- | --- | --- |
| `LIFECYCLE_FIELD_INVALID` | error | `field` is not an `enum` field of the entity |
| `LIFECYCLE_INITIAL_NOT_STATE` | error | `initial` not in the enum |
| `LIFECYCLE_TRANSITION_TARGET_UNKNOWN` | error | `to` (or a `from`) misspelled — structured diagnostic, not a runtime surprise |
| `LIFECYCLE_TRANSITION_DUPLICATE` | error | same `(event, from-state)` → two targets: a nondeterministic next-state is **unrepresentable**, same philosophy as rejecting `Date.now()` |
| `LIFECYCLE_STATE_UNREACHABLE` | warning | no path from `initial` enters this state |
| `LIFECYCLE_FIELD_IMMUTABLE` | error | a `crud` `update` on a lifecycled entity writes the state field |
| `INVARIANT_TERM_UNKNOWN` | error | guard/invariant term does not resolve to a node |
| `EFFECT_TARGET_UNKNOWN` / `EFFECT_PAYLOAD_FIELD_UNKNOWN` | error | effect references a missing entity or field |
| `EXPR_NOT_LOWERCABLE` | error | vocabulary-purity catch-all (§2 litmus) |

Because the vocabulary is closed and first-order-ish, further analyses become
possible later (guard satisfiability against reachable states, invariant
interaction reports) without new spec surface.

## 6. Lowering: interpretation moves into the compiler

**Transition → action endpoint + atomic guarded update.**

```
POST /bookings/{id}/confirm
```

```sql
UPDATE bookings SET status = 'confirmed'
WHERE id = :id AND status IN ('pending') AND starts_at > now()
RETURNING *;
-- rowcount = 0 → 409; same transaction: invariant re-check + outbox insert
```

Two concurrent `confirm`s are serialized by the database; the loser gets
`rowcount = 0` → pinned `409`. No read-check-write race exists because the
guard never left SQL.

**Invariant → classified by span.** Single-row invariants lower to `CHECK`
constraints; cross-row ones (like `no-overbooking`) lower to a transactional
re-check (plus an optional generated constraint where the target supports it,
e.g. PostgreSQL).

**Effects → executed in the transaction, declared order, all-or-nothing.**
`effect.emit` writes a row to a generated `events` (outbox) table — event
sourcing's audit benefit as plain data, without adopting its architecture.

**Blueprint gains a `behavior` section per route** — the increment OpenAPI
structurally cannot carry, handed to the agent as a table, not prose:

```
POST /bookings/{id}/confirm
guard:      status ∈ {pending} AND startsAt > request.time
updates:    status = confirmed
effects:    emit booking.confirmed(id, venue, startsAt)
invariants: no-overbooking (re-check)
outcomes:   200 → Booking | 409 GUARD_FAILED | 409 INVARIANT_VIOLATED | 401
```

Status codes are pinned by convention — input shape invalid → `422`,
guard/invariant failure → `409`, unauthenticated → `401` — overridable per
operation. The failure *shape* is as much a contract as the success shape;
the agent does not choose it.

## 7. Conformance: generated from the same data

| Test | Generated from | Asserts |
| --- | --- | --- |
| Legal transition × each `from` state | transition table | `200` + new state + effects observable (outbox row exists) |
| Illegal transition × each non-`from` state | complement of the transition table | `409` |
| Invariant violation attempt | `invariant` nodes | minimally violating world → request rejected |
| `update` writes state field | — | rejected at compile time (§5); no runtime test needed |

The lifecycle gives the universal claim ("only these transitions"), example
fixtures give point anchors (exact response bodies). Test data comes from
fixed, seedless fixtures — `Math.random` is as forbidden in conformance as in
the spec — so the golden rule holds end to end: same spec in ⇒ same IR ⇒ same
blueprint ⇒ same behavior ⇒ same tests.

## 8. Package placement

Declaration and lowering stay separated, as the existing architecture already
does (`crud` declares REST vocabulary; `@spec/fastapi` lowers it):

- kernel + builders (`lifecycle`, `transition`, `invariant`, `effect`, `expr`)
  live in the semantic layer — `@spec/web` or a new small `@spec/behavior`;
- `@spec/fastapi` lowers transitions → routes, guards → SQL/ORM predicates,
  outcomes → response models; blueprint gains the `behavior` section;
- `@spec/postgres` lowers invariants → constraints;
- conformance generation extends the existing harness from the same nodes.

## 9. Rollout

- **Phase 1 — lifecycle.** `lifecycle`/`transition` (no guards, no effects) +
  the §5 validators + lowering to action endpoints with pinned `409` +
  conformance matrix. The booking example gains `confirm`/`cancel`; the loop
  `spec.ts → IR → blueprint → agent → conformance` closes end to end.
- **Phase 2 — invariant.** Single-entity first, then cross-entity `count`.
  Pinned `409`/`422` outcomes + violation tests.
- **Phase 3 — effects.** `effect.set` / `effect.emit` + the outbox `events`
  table; guard vocabulary grows strictly by demand, and every new term must
  pass the SQL litmus test.

Explicitly not planned: temporal logic, rule engines, BPMN/process calculi,
arbitrary-predicate pre/postconditions — each either reintroduces
interpretive discretion or surrenders decidability (§2).

## 10. The acceptance test

One criterion decides whether this design succeeded:

> In a generated backend, every ounce of behavioral semantics must point back
> at a span of data in the IR — lifecycle says *when it is allowed*,
> invariants say *what always holds*, effects say *what follows*, outcomes say
> *what failure looks like*.

The agent never says anything of its own.
