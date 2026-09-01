/**
 * Deterministic verification plan for generated FastAPI workspaces.
 *
 * Executed by the agent orchestrator (@spec/agent) after each generation
 * and repair round. All commands must exit 0 for a shot to count as
 * conformant. This is the compiler's independent check — the agent is
 * instructed to run tests too, but it is never trusted to grade itself.
 */
export interface VerificationCommand {
  name: string
  command: string
  timeoutMs: number
}

export interface VerificationPlan {
  setup: VerificationCommand[]
  check: VerificationCommand[]
}

export function fastApiVerification(): VerificationPlan {
  return {
    setup: [
      // --clear keeps verification idempotent; --python pins the stack's
      // interpreter version (the stack is part of the spec).
      { name: "venv", command: "uv venv .venv --clear --quiet --python 3.13", timeoutMs: 180_000 },
      { name: "install", command: "uv pip install --quiet -e '.[dev]'", timeoutMs: 600_000 },
    ],
    check: [
      {
        name: "import",
        command: '.venv/bin/python -c "from app.main import app, create_app; assert app.title"',
        timeoutMs: 60_000,
      },
      {
        name: "conformance",
        command: ".venv/bin/python -m pytest conformance -q",
        timeoutMs: 300_000,
      },
    ],
  }
}
