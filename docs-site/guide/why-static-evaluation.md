# Why the IR is statically evaluated, not executed

The compiler turns a `.spec.ts` into a Spec IR using a **static evaluator**
(`packages/compiler/src/evaluate.ts`): it walks the TypeScript AST and
evaluates the allowed expression subset itself, instead of importing the
file and letting JavaScript run it.

The obvious question: *isn't that a lot of machinery?* The spec file is
ordinary TypeScript; the builders are ordinary functions; `node` could
just execute the file and hand us the builders. For **valid**
specifications both approaches produce exactly the same IR — so the
machinery has to pay for itself on the **invalid** and **adversarial**
paths. It does, three times over. Each example below is runnable against
this repository.

## 1. Determinism must be enforced, not encouraged

The whole system stands on one property: *same spec in ⇒ byte-identical
`spec.ir.json` out* (asserted by a 100-compile SHA-256 test). The golden
rule inherits it — a nondeterministic IR means a nondeterministic
blueprint, and agents receiving different contracts per shot.

Now consider this specification:

```ts
const startedAt = Date.now()                       // ← what stops this?
const Event = entity("Event", {
  id: field.uuid(),
  opensAt: field.datetime().default(startedAt),
})
```

- **Direct execution**: `Date.now()` *runs*. The timestamp lands in the
  builder, the IR, and every artifact. Two builds differ, the
  determinism test fails, and downstream the two generation shots read
  different blueprints. Nothing is violated loudly — the property just
  silently stops being true.
- **Static evaluation**: the restriction scan rejects
  `SPEC_FORBIDDEN_ACCESS — Accessing Date.now is forbidden in
  specifications (nondeterministic or side-effecting)` **before any value
  exists**. Nondeterminism is *unrepresentable*, not merely discouraged.

The same holds for `Math.random()`, `process.env`, filesystem reads and
network calls: a compiler that executes the spec can only *ask* the
author not to do those things. A compiler that evaluates it can
*guarantee* they never happened.

## 2. Anonymous builders have no names at runtime

Node ids are `kind:name` — and half the nodes in every real spec are
anonymous builders whose names come from their `const` binding:

```ts
const MainAuth = auth({ principal: User, strategy: password({ ... }) })
//      ↑ the ONLY place the name "MainAuth" exists
```

- **Direct execution**: when `auth(...)` returns, JavaScript has no way to
  know which variable the result is about to be assigned to — there is no
  such reflection. The node's identity degenerates to statement order
  (`auth:root#3`), so reordering declarations *changes node ids*, breaks
  every reference, and makes the IR unstable under harmless edits. The
  workaround is naming everything by hand — `auth("MainAuth", {...})` —
  i.e. changing the DSL to work around the execution model.
- **Static evaluation**: the evaluator sees the declaration
  (`decl.name.text`), adopts the binding name, and the node becomes
  `auth:MainAuth` — deterministic, readable, and stable across reordering.
  This is also what makes `toReference` possible: references to anonymous
  nodes would simply be unconstructable at runtime.

## 3. Diagnostics are a protocol, not stack traces

The architecture's diagnostic contract is
`Compiler → Diagnostic → Author or tooling`: every problem arrives as a
structured record with a stable code, a source location and
machine-readable details. Break one line of a spec:

```ts
const MainAuth = auth({
  principal: User,
  strategy: password({ identity: User.fields.mail }),  // ✗ typo: "mail"
})
```

- **Static evaluation** produces:

  ```
  SPEC_UNKNOWN_PROPERTY
  app.spec.ts:6:47

  Cannot read property "mail" from a "User" spec node.
  ```

  Exit code `1` (a *specification* error), with `details` an agent can
  consume to propose the repair.
- **Direct execution** produces:

  ```
  TypeError: Cannot read properties of undefined (reading 'mail')
      at password (/…/packages/auth/dist/builders.js:31:19)
      at …
  ```

  A raw JavaScript stack whose frames point into the *package's*
  internals, not the user's spec line semantics. The compiler cannot
  classify this failure — it must report exit code `2` (*internal*
  error) for what is actually a typo, and downstream tooling has nothing
  structured to work with. Every such case needs bespoke
  try/catch-and-parse-English heuristics.

## Where the simple approach is genuinely fine

To be fair to "just run it": if your specs are always valid, always
trusted, and never reordered, direct execution produces the same IR with
less code. It is the right choice for a script. This project's goal,
however, is a *compiler whose output is a contract* — for machines and
agents downstream — and a contract is only as good as its worst input.
The evaluator (~370 lines) is the price of:

| Guarantee | Mechanism |
| --- | --- |
| Byte-stable IR | nondeterministic constructs unrepresentable |
| Stable node ids | const-binding name adoption |
| Machine-actionable failures | codes + positions + details, not stack traces |
| "User code is data" | nothing in the file ever executes |

All four are load-bearing for [the golden rule](/guide/golden-rule):
repeatable generation needs a repeatable *input*, and the input is only
provably repeatable if the compiler — not the JavaScript runtime —
decides what running the spec means.
