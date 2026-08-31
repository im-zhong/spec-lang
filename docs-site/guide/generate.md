# Agentic generation

`spec generate` is where the two halves of the compiler meet: the
**traditional** half (deterministic passes, IR, blueprint, conformance
suite) and the **agentic** half (a coding agent that writes the actual
application).

```bash
pnpm spec generate examples/booking/app.spec.ts --shots 2
```

Requires the `claude` CLI on `PATH` (headless mode), `uv`, and Python 3.10+.

## What happens

```
.spec.ts
  │  parse → resolve → normalize → validate → link     (deterministic)
  ▼
Spec IR
  │  @spec/fastapi lowering (pure function)
  ▼
BackendBlueprint ──► agent tasks (prompts, deterministic)
  │                        │
  │                        ▼  claude -p (headless, tool-restricted)
  │                   generated FastAPI app in out/<app>-<n>/
  ▼
conformance suite (compiler-owned pytest) ──► verification
  │                                            │ failure → repair prompt
  ▼                                            ▼ (bounded rounds)
repeatability report (.spec/agent.result.json)
```

1. **Plan** — the compiler lowers the IR to a *blueprint*: a complete,
   pinned description of the backend (entities, routes, status codes,
   request/response shapes, error bodies, auth flow). `--dry-run` stops
   here and writes `blueprint.json` + `agent.tasks.json`.
2. **Generate** — for each shot, a fresh workspace (`out/<app>-<n>/`) is
   created and the agent implements the blueprint with its file tools.
   The prompt is a pure function of the blueprint.
3. **Verify** — the compiler drops its own pytest conformance suite into
   the workspace and runs the verification plan
   (`uv venv`, `uv pip install -e '.[dev]'`, import check, `pytest conformance`).
   Failures are fed back to the agent for repair (bounded rounds).
4. **Repeat** — N independent shots must all pass the *same* suite and
   expose the *same* normalized OpenAPI interface (see
   [the golden rule](/guide/golden-rule)).

## CLI options

| Flag | Meaning | Default |
| --- | --- | --- |
| `--shots <n>` | independent generations per spec | `2` |
| `--dry-run` | plan only, no agent | — |
| `--out <dir>` | generated-app root | `out/` |
| `--model <id>` | agent model | `SPEC_AGENT_MODEL` or `claude-sonnet-4-5` |
| `--repair-rounds <n>` | verification failures fed back for repair | `2` |
| `--max-turns <n>` | agent turn budget per run | `60` |

Exit code `1` means a shot failed conformance or shots diverged — the
golden rule was not satisfied.

## Artifacts

| File | Content |
| --- | --- |
| `.spec/blueprint.json` | the pinned behavioral contract |
| `.spec/agent.tasks.json` | the agentic lowering (tasks + prompt hash) |
| `.spec/agent.result.json` | per-shot verification, repairs, artifacts, repeatability |
| `out/<app>-<n>/` | the generated application (runnable) |

The agent never grades itself: verification commands and the conformance
suite are produced by the compiler and re-dropped before every check.
