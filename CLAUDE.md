# spec-lang — working charter

This repo combines a traditional compiler (TypeScript DSL → Spec IR →
blueprint) with a headless coding agent (`claude -p`) that implements the
blueprint. The specification is meant to **replace** the programming
language: anything the agent "decides" is a contract the spec failed to pin.

## The golden rule (complete form)

> The same `.spec.ts` generated N times must produce software that is
> individually conformant, mutually identical, **and correct**.

1. **Conformance** — every shot passes the compiler's conformance suite on
   its FIRST attempt. There is no repair loop, by policy; conformance files
   are compiler-owned truth dropped into the workspace after generation.
2. **Equality** — all shots expose the same observable behavior: identical
   normalized OpenAPI + compiler-owned behavior snapshots (backends), or
   pixel-identical per-screen `layout-N.png` / `behavior.png` +
   byte-identical `behavior.json` (frontends).
3. **Correctness** — equality is necessary, **not sufficient**. Identical-
   but-wrong output is a specification defect. Everything the spec declares
   must exist and work: every navigation target resolves to a real screen
   (`UI_NAV_TARGET_UNKNOWN` rejects dead links at compile time; the oracle
   also click-verifies each nav item), every declared control, state
   transition, and invariant behaves as specified. The oracle must encode
   (3), not just (1)+(2).

## The one forbidden move

**Never patch generated code to pass verification.** A failing shot is a
defect in the contract, not in the code. Fix, in order of preference:

1. spec vocabulary / validators (`packages/*` — catch it at `spec check`)
2. compiler lowering / blueprint / runtime / conformance oracle
   (`packages/fastapi`, `packages/react`, …)
3. the example spec itself (`examples/*/app.spec.ts`)
4. harness / verification plan (`packages/agent`) — infrastructure only

Then **regenerate every shot from scratch** (fresh workspaces, judged once,
no reuse). Record the gap in `docs/golden-rule-results.md`.

## Operational workflow

1. **Deterministic checks first** — `spec check`, `--dry-run`, and unit
   tests (`pnpm build && npx vitest run <paths>`) must be green before any
   agent spend. Validate a changed verification plan by replaying it on a
   failed run's wiring files before re-rolling agents.
2. **Generate** — `spec generate <file> --shots N` (backend) or
   `spec generate-frontend <file> --shots N` (frontend). Shots run in
   parallel; each gets a fresh workspace `out/<app>-<i>` (wiped, marked
   `.spec-generated`), the same seeds, the same oracle, ONE judgment.
3. **Read evidence** — `.spec/agent.result.json` / `.spec/frontend.result.json`
   hold per-shot verdicts, verification output, scope audit, equality
   hashes, and cost. Never judge by eye alone; never accept a repair.
4. **On failure** — diagnose to the root cause, fix the contract (see
   above), regenerate ALL shots, and compare again.
5. **Visual confirmation** — for frontends, run both apps
   (`<workspace>/node_modules/.bin/vite --host 127.0.0.1 --port <unique>`)
   and compare rendered layout, behavior, and navigation by eye + DOM.

## Isolation discipline

Shot workspaces are **independent package roots** living under a pnpm
monorepo — independence is the entire premise of the golden rule, and it
applies to every command that touches them:

- Any install inside `out/*` JS workspaces must be
  `pnpm install --ignore-workspace` — a plain `pnpm install` is captured by
  the enclosing workspace and installs the wrong scope.
- Never run repo-level commands (build, test, vitest, git) from inside a
  shot directory; always `cd` to repo root first. A stray `pnpm build` in a
  workspace runs *that workspace's* vite build.
- Start dev servers from each workspace's own binary
  (`out/<app>-<i>/node_modules/.bin/vite`), one port per shot; bare
  `pnpm dev` can trigger `verifyDepsBeforeRun` installs that mutate the
  workspace mid-serve.
- Agents may write only their declared scope; the harness audits every
  file change, and conformance is the only judge.

## Repository boundary — never confuse the tool with its target

`spec-lang` is the source repository for the specification compiler,
generator, execution engine, and their tests. It is **not** the repository in
which a generator run stores generated products or its GitHub control-plane
state.

- The GitHub-native workflow is a facility used **by the spec generator** to
  operate on an explicitly selected, separate target/generation repository.
  That target repository owns the immutable plan refs, task/base branches,
  generated commits, task/final PRs, and required checks.
- Never infer that the current `spec-lang` checkout or its `origin` is the
  generation target. Never default generated output to `products/*` in this
  repository, and never create `spec/generate/**` refs, generator-produced
  commits, or generator-produced PRs here.
- A target repository/checkout must be supplied explicitly. If it is absent,
  stop with a clear error instead of falling back to the current repository.
  A `--repository` option must select the target; it must not merely assert
  that the current checkout's origin has the same name.
- Keep the roles physically and conceptually separate:

  ```text
  spec-lang repository                 target/generation repository
  --------------------                 ----------------------------
  compiler + generator code   ----->   plan refs + task branches
  execution/container tooling          generated product commits
  framework tests                      generator PRs + GitHub checks
  ```

- Ordinary development branches and review PRs that change `spec-lang`
  itself are separate from the generator workflow; do not use their existence
  as evidence that a generator run belongs in this repository.

## Pointers

- Pinned gaps and run history: `docs/golden-rule-results.md`
- Backend anti-overfit trio: `examples/cblog`, `examples/inventory`,
  `examples/booking` must all pass `spec generate --shots 2`
- Frontend acceptance: `examples/frontend-golden` (multi-screen, live nav)
- Agent runs are slow and cost real money (~$1–4/shot backend, 10–30 min;
  frontend wiring ~$0.4, ~2 min). E2E agent tests are opt-in via
  `SPEC_AGENT_E2E=1`.
