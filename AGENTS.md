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

Then **regenerate every shot from scratch** (fresh repositories, judged once,
no reuse). Record the gap in `docs/golden-rule-results.md`.

## Operational workflow

1. **Deterministic checks first** — `spec check`, `--dry-run`, and unit
   tests (`pnpm build && npx vitest run <paths>`) must be green before any
   agent spend. Validate a changed verification plan by replaying it on a
   failed run's wiring files before re-rolling agents.
2. **Generate** — `spec generate <file> --shots N` (backend) or
   `spec generate-frontend <file> --shots N` (frontend). Shots run in
   parallel; the generator creates a fresh temporary GitHub repository and a
   distinct local checkout/worktree root for each shot. Every shot receives
   the same frozen inputs and exactly one conformance judgment.
3. **Read evidence** — `.spec/generation/<run-id>/` holds per-shot immutable
   plans and result reports; each target repository holds its generated
   commits, PRs, checks, and compiler evidence. Never judge by eye alone;
   never accept a repair.
4. **On failure** — diagnose to the root cause, fix the contract (see
   above), regenerate ALL shots in fresh repositories, and compare again.
5. **Visual confirmation** — for frontends, run both apps from their own shot
   checkouts on unique ports and compare rendered layout, behavior, and
   navigation by eye + DOM.

## Isolation discipline

Shot workspaces are independent target repositories and local checkout roots;
they never live as sibling outputs in the spec-lang pnpm monorepo.

### Required repository topology for shots

Repository isolation is part of shot independence, not an optional execution
detail. For every non-dry-run golden-rule generation:

- The spec generator itself MUST use the GitHub CLI (`gh`) to create one
  disposable temporary GitHub repository per shot. Callers must not have to
  pre-create or manually supply those target repositories.
- Every shot MUST have both a distinct remote GitHub repository and a distinct
  local checkout/worktree root. Two shots that share a remote but use different
  branches, run ids, target directories, or worktrees are **not independent**
  and MUST NOT count as golden-rule evidence.
- The same frozen Spec IR, generation plan semantics, compiler-owned oracle,
  and pinned execution environment MUST be applied independently in each
  repository. Generated commits, refs, PRs, checks, and evidence belong only
  to that shot's repository.
- Cross-shot comparison happens only after each repository has independently
  passed first-attempt conformance. Compare compiler-owned evidence across the
  repositories; never compare two directories or branches from one remote as
  a substitute.
- Temporary repositories must be named/marked so their ownership and run id
  are auditable. Preserve failed repositories long enough for diagnosis;
  cleanup is an explicit lifecycle step and must never erase the only failure
  evidence.

If the implementation cannot create this topology, stop before spending agent
tokens and report a generator implementation defect. Do not fall back to the
legacy local `runRepeatability` harness or to multiple branches/directories in
one target repository.

- Run installs, tests, Git commands, and dev servers against the intended
  shot's local checkout/worktree only; never let an enclosing spec-lang
  workspace capture a generated project command.
- For generated JS projects use the shot checkout's own package-manager and
  binary paths. Each concurrently running app gets a unique port.
- Agents may write only their declared scope; the harness audits every
  file change, and conformance is the only judge.

## Repository boundary — never confuse the tool with its target

`spec-lang` is the source repository for the specification compiler,
generator, execution engine, and their tests. It is **not** a repository in
which a generator run stores generated products or GitHub control-plane state.

- The GitHub-native workflow is a facility used **by the spec generator** to
  create and operate on separate per-shot target/generation repositories.
  Each target repository owns only its shot's immutable plan refs, task/base
  branches, generated commits, task/final PRs, and required checks.
- Never infer that the current `spec-lang` checkout or its `origin` is a
  generation target. Never default generated output to `products/*` in this
  repository, and never create `spec/generate/**` refs, generator-produced
  commits, or generator-produced PRs here.
- The generator creates each concrete target repository itself through `gh`.
  The caller may provide an owner/name prefix, but must not have to create or
  explicitly supply the per-shot repositories. If automatic target creation
  fails, stop instead of falling back to the current repository.
- Keep the roles physically and conceptually separate:

  ```text
  spec-lang repository                 temporary shot repositories
  --------------------                 ---------------------------
  compiler + generator code   ----->   shot-1: remote + local checkout
  execution/container tooling  ----->   shot-2: remote + local checkout
  framework tests                       each owns refs/commits/PRs/checks
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
