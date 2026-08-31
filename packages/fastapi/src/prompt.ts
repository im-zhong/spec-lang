/**
 * Deterministic prompt construction for the agentic pass.
 *
 * Prompts are a pure function of the blueprint — no timestamps, no
 * randomness, no session state. Identical specs produce identical prompts,
 * which is a precondition for repeatable generation (golden rule).
 */
import { stableStringify } from "@spec/core"
import type { BackendBlueprint } from "./blueprint"

export function implementPrompt(bp: BackendBlueprint): string {
  const routes = bp.routes
    .map((r) => {
      const cells = [
        r.method,
        r.path,
        String(r.status),
        r.auth ? "bearer" : "public",
        r.operation + (r.entity ? `(${r.entity})` : ""),
      ]
      return `| ${cells.join(" | ")} |`
    })
    .join("\n")

  return `You are implementing a FastAPI web backend. A specification
compiler statically analyzed the user's specification and derived the
backend blueprint below. The blueprint is a COMPLETE behavioral contract:
implement it exactly. An automated conformance suite derived from the same
blueprint will be dropped into ./conformance/ after you finish and MUST
pass. Do not create or modify anything under conformance/.

# Blueprint (the contract)

\`\`\`json
${stableStringify(bp)}
\`\`\`

# Route table (exact interface)

| method | path | success | auth | operation |
| --- | --- | --- | --- | --- |
${routes}

# Hard requirements

## Project layout
- Python package \`app/\` with \`app/main.py\` as the entrypoint.
- \`app/main.py\` MUST export \`create_app(database_url: str | None = None) -> FastAPI\`
  (application factory, creates tables on startup) and a module-level
  \`app = create_app()\`.
- \`pyproject.toml\` making the project installable, with a \`dev\` extra
  containing at least \`pytest\` and \`httpx\` (the conformance suite runs
  with TestClient). Dependencies: fastapi, uvicorn, sqlalchemy (2.x),
  pydantic (v2), pydantic-settings, passlib[bcrypt], pyjwt.
- Do not add any route, endpoint, or path beyond the route table — the
  conformance suite asserts STRICT OpenAPI path/method equality.
  (FastAPI's automatic /openapi.json and /docs are fine; add nothing else.)

## Data layer
- SQLAlchemy models for every entity; table names from the blueprint
  (\`table\`), column names from \`column\`.
- Server-side generated uuid4 primary keys (\`id\`).
- Implicit \`created_at\` datetime column on every entity (UTC, set once on
  insert): used ONLY to order list results ascending; NEVER serialized.
- The auth principal has an implicit ${bp.auth ? `\`${bp.auth.passwordColumn}\`` : "`password_hash`"} column (bcrypt hash); NEVER serialized.
- Database URL comes from \`create_app(database_url=...)\`, falling back to
  the \`${bp.database.urlEnv}\` env var, falling back to \`${bp.database.fallback}\`
  (SQLite). \`database_url\` (and the env var) are ALWAYS SQLAlchemy URL
  strings, e.g. \`sqlite:///./dev.db\` or
  \`postgresql+psycopg://user:pass@host/db\` — normalize bare paths to a
  \`sqlite:///\` URL. Use SQLite-compatible SQL only (tests run on SQLite).

## REST semantics (pinned — the suite asserts these exactly)
- Entity JSON keys are the field names EXACTLY as declared in the blueprint
  (camelCase stays camelCase). Every declared field appears in responses.
- \`ref\` fields serialize as the referenced row's id string.
- Optional fields without a default serialize as \`null\` when unset.
- \`create\` returns 201 with the stored row (id and defaults applied; \`id\`
  in the request body is ignored). Fields with a declared default are
  OMITTABLE from create bodies — omitting them applies the default;
  optional fields without a default store \`null\`.
- \`update\` is PATCH-partial: any subset of fields; returns 200 with the
  full row.
- \`delete\` returns 204 with an empty body.
- \`list\` returns a bare JSON array ordered by \`created_at\` ascending.
- \`count\` endpoints return \`{"count": <int>}\`.
- Path parameter is named exactly \`id\` (route functions must use \`id\`).
- Register the \`count\` route BEFORE any \`{id}\` route of the same prefix.

## Error contract (pinned — the suite asserts exact bodies)
- Missing/invalid bearer token on a protected route: 401 \`{"detail": "Not authenticated"}\`
- Unknown \`id\` on get/update/delete: 404 \`{"detail": "Not found"}\`
- \`ref\` field pointing at a nonexistent row on create/update: 404 \`{"detail": "Not found"}\`
- Unique-field violation on create/update/register: 409 \`{"detail": "Already exists"}\`
- Field validation failures: standard FastAPI 422 (\`{"detail": [...]}\`).

${
  bp.auth
    ? `## Auth (${bp.auth.strategy})
- \`POST ${bp.auth.routes.find((r) => r.operation === "register")!.path}\`: body = principal
  fields + \`"password"\` (plaintext, hashed with bcrypt before storage);
  201 with the principal row (never the hash). Duplicate identity → 409.
- \`POST ${bp.auth.routes.find((r) => r.operation === "login")!.path}\`: body =
  \`{"${bp.auth.identityField}": ..., "password": ...}\`; 200 with
  \`{"access_token": "<jwt>", "token_type": "bearer"}\`; wrong identity or
  password → 401 \`{"detail": "Invalid credentials"}\`.
- \`GET ${bp.auth.routes.find((r) => r.operation === "me")!.path}\`: bearer
  token → 200 principal row.
- Protected routes (auth=true in the route table) require a valid bearer
  JWT (HTTPBearer-style dependency).
`
    : "## Auth\n- This specification has no auth service: every route is public.\n"
}
# Definition of done
1. \`uv venv .venv && uv pip install -e ".[dev]"\` succeeds.
2. \`.venv/bin/python -c "from app.main import app, create_app"\` succeeds.
3. \`.venv/bin/python -m pytest conformance -q\` passes (after the compiler
   drops the suite in).

Write clean, idiomatic, production-grade code — routers per resource,
Pydantic schemas, dependency-injected DB sessions, no TODOs or stubs.`
}

export function repairPrompt(bp: BackendBlueprint, failure: {
  command: string
  exitCode: number | null
  output: string
}): string {
  return `The FastAPI backend you generated for the blueprint below FAILED
verification. Fix the workspace so that every verification command passes.
The failure was:

COMMAND: ${failure.command}
EXIT CODE: ${String(failure.exitCode)}
OUTPUT (tail):
${failure.output}

Remember the contract: exact route set (no extra routes), exact response
keys, exact error bodies, exact status codes, \`create_app(database_url)\`
factory in \`app/main.py\`, conformance suite in ./conformance/ is
compiler-owned — never modify it. Rerun the failing command yourself to
confirm the fix before finishing.

# Blueprint (the contract)

\`\`\`json
${stableStringify(bp)}
\`\`\``
}
