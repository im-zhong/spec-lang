# Source walkthrough: frontend-golden, end to end

This page traces `examples/frontend-golden/app.spec.ts` through the current
implementation: TypeScript UI spec → frontend blueprint → compiler-owned
React runtime → one wiring agent task per shot → a Playwright oracle that
judges layout, behavior, and navigation. Artifacts are from the 2026-09-02
two-shot run.

```bash
spec check examples/frontend-golden/app.spec.ts
spec generate-frontend examples/frontend-golden/app.spec.ts --dry-run
spec generate-frontend examples/frontend-golden/app.spec.ts --shots 2
```

The app is Spec Studio: three screens (`/`, `/projects`, `/reports`) sharing
one navigation, a stat row, an ARIA tablist with a create-project form, and
collection-backed tables.

## System map

```text
app.spec.ts
    |
    | compile -> Spec IR
    v
planFrontendGeneration()
    |- buildFrontendBlueprint()   screens, components, stack, contract
    |- buildFrontendDag()         1 task: "React frontend integration shell"
    |- buildRuntimeFiles()        src/spec-runtime.tsx + .css + blueprint.json
    |- buildFrontendConformanceSuite()  contract.json + playwright.config.ts + frontend.spec.ts
    '- frontendVerification()     install / browser / build / playwright
    |
    | runShot() x2, parallel, independent workspaces
    +------ shot-1: seed -> agent -> conformance -> judge once ----+
    +------ shot-2: seed -> agent -> conformance -> judge once ----+
                                                                   |
                            compareFrontendShots(): per-screen pixel hashes
                            + behavior.png + behavior.json equality
```

## The blueprint

`buildFrontendBlueprint` lowers the IR into a versioned JSON document
(`frontend-blueprint/0.1`): app name/title/port, theme, screens (sorted by
path, each with its state and body tree), the sorted component kinds, the
pinned dependency stack (exact versions — react 19.2.8, vite 8.2.2,
playwright 1.62.1, …), and the layout contract: viewport 1440×900, sidebar
264px, content max-width 1120px, and the exact chrome colors the oracle
asserts (`rgb(244,246,251)` body, `rgb(23,37,84)` sidebar).

The blueprint is the single source of truth downstream: the runtime renders
it, the oracle asserts it, and the equality check hashes its outputs.

## The compiler-owned runtime

`buildRuntimeFiles` emits `SpecApp`, a React component that interprets the
blueprint: routing by pathname across the declared screens, screen-local
collections and tab state, declarative action sequences (append ids are
`collection length + 1`), and one CSS file that pins every visual decision —
spacing, radii, badge palettes, focus rings. The agent never touches this
file; visual equality between shots is inherited from the compiler, not
negotiated by the agent.

## One agent task: wiring only

The DAG has a single task whose scope is exactly `package.json`,
`index.html`, `src/main.tsx`. The prompt pins `package.json` semantically
(from the blueprint stack), the HTML skeleton (`lang="en"`, title, `#root`,
one module script), and the `main.tsx` import graph. It ends: "Do not
reinterpret the blueprint… This task is wiring only."

Shot workspaces live under `out/<app>-frontend-N` inside the monorepo, so
the verification plan installs with `pnpm install --ignore-workspace` — a
plain install is captured by the enclosing workspace and never installs the
shot's manifest. Every dependency is an exact pin, so both shots resolve
identical trees.

## The oracle

One Playwright test (`conformance/frontend.spec.ts`), generated from the
blueprint, judging on the first attempt:

1. **Correctness gate** — every navigation href on every screen must equal a
   declared screen path; the test fails with
   `matches no declared screen path` otherwise. (Compile-time twin:
   `UI_NAV_TARGET_UNKNOWN`.)
2. **Per-screen render** — for each screen: document title, `data-screen`,
   heading, sidebar/main geometry against the layout contract, chrome
   colors, component kinds against the declared vocabulary, and a full-page
   `layout-N.png`.
3. **Navigation click-through** — from the first screen, click every nav
   item and assert the landed screen and heading; recorded into the
   behavior snapshot.
4. **Interaction contract** — on the screen owning the form: switch tab,
   fill fields (last select option), submit, assert the notification, tab
   reselection, appended row cells, and the stat increment
   (`collection length + 1`); capture `behavior.png` and `behavior.json`.

## Equality evidence

`compareFrontendShots` hashes every `layout-N.png` and `behavior.png` and
canonically stringifies `behavior.json` (screen list, navigation outcomes,
rows, component counts, geometry, colors). All files must exist in the same
set with identical hashes in every shot. From the reference run:

| Evidence | shot-1 | shot-2 |
| --- | --- | --- |
| `layout-0.png` | `930c8bc0e171aa4b…` | identical |
| `layout-1.png` | `b23fd4b0ae812217…` | identical |
| `layout-2.png` | `22f5339f8ba46d39…` | identical |
| `behavior.png` | `940c4ea831079f82…` | identical |
| `behavior.json` | byte-identical | byte-identical |

Both shots passed on their first attempt with zero scope violations
($0.47 + $0.35).

## Why this is strict: the correctness clause

An earlier one-screen version of this spec declared the same sidebar with
`href: "/#projects"` and `href: "/#reports"` — routes no screen implemented.
Both shots rendered the dead links identically and the then-current oracle
(passing) saw only `screens[0]` and never clicked navigation. Generation was
"repeatable" and wrong.

The fix is the golden rule's correctness clause: equality is necessary, not
sufficient. Navigation is now pinned in three independent layers — the
`UI_NAV_TARGET_UNKNOWN` compile gate, the oracle's dead-link assertion, and
per-screen click-through evidence — and the spec declares three real
screens. A consistency check can only ever prove (1) and (2); the spec
language and the oracle must also prove (3).
