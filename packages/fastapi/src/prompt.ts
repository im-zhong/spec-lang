/**
 * Per-task prompt construction for DAG-driven generation.
 *
 * The generation unit is NOT "the whole backend" — it is one task in a
 * dependency graph (models → schemas/security → routers → app). Each
 * task's prompt is a pure function of the blueprint slice it needs:
 * narrow scope, explicit file ownership, previous artifacts readable.
 *
 * Every prompt is KERNEL + BRIEF. The kernel renders the node's clause
 * table (see clauses.ts) — the complete behavioral contract, shared
 * byte-for-byte with the node oracle and the reviewer checklist — plus
 * the shared operational constraints and the contract challenge
 * protocol. The brief carries engineering guidance and reference data
 * blocks, explicitly subordinate to the clause table.
 *
 * Determinism rules: no timestamps, no randomness, no session state.
 * Identical blueprints produce identical prompts (and identical DAGs).
 */
import { stableStringify, type ContractClause } from "@spec/core"
import type { BackendBlueprint } from "./blueprint"

const CHALLENGE_PROTOCOL = `## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.`

function sharedOperationalConstraints(bp: BackendBlueprint): string {
  return `## Shared operational constraints
- Path parameters are named exactly \`id\`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 ${JSON.stringify(bp.contract.errors.unauthenticated.body)} · 404 ${JSON.stringify(bp.contract.errors.notFound.body)} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.`
}

/** Package-owned instructions selected for one target task kind. */
function guidanceSection(bp: BackendBlueprint, taskKind: string): string {
  const contributions = bp.generation.contributions.filter((contribution) =>
    contribution.tasks.includes(taskKind),
  )
  if (contributions.length === 0) return ""
  const lines = ["## Target and package engineering guidance"]
  for (const contribution of contributions) {
    lines.push("", `### ${contribution.package} · ${contribution.id}`)
    for (const instruction of contribution.instructions) lines.push(`- ${instruction}`)
  }
  lines.push(
    "",
    "This guidance is subordinate to the node contract in the clause table.",
    "If guidance appears to conflict with a clause, implement the clause.",
  )
  return lines.join("\n")
}

/**
 * The complete cross-module import surface one task may rely on, compiled
 * from the frozen blueprint. The agent never has to discover sibling APIs
 * by reading their sources — the compiler already knows the exact slice
 * this task consumes (it pins the same names in the clause table).
 */
function interfaceSlice(bp: BackendBlueprint, deps: string[]): string {
  const lines: string[] = []
  const entityNames = bp.entities.map((e) => e.name).join(", ")
  if (deps.includes("database")) {
    lines.push("- `app.database`: Base, engine, SessionLocal, get_db() (yields a Session, always closes it), normalize_database_url(value), resolve_database_url(explicit=None), create_engine_from_url(explicit=None), create_session_factory(engine), session_dependency(factory)")
  }
  if (deps.includes("models")) {
    lines.push(`- \`app.models\`: Base plus one SQLAlchemy class per entity — {${entityNames}}`)
  }
  if (deps.includes("schemas")) {
    lines.push(`- \`app.schemas\`: per entity <Entity>Create / <Entity>Update / <Entity>Out — {${entityNames}}; the exact field sets are pinned in your clause table`)
  }
  if (deps.includes("security")) {
    lines.push("- `app.security`: hash_password(secret), verify_password(secret, password_hash | None) -> bool, create_access_token(subject) -> str, decode_access_token(token) -> str | None")
    lines.push("- `app.deps`: get_current_user — the bearer-token dependency that raises the pinned 401")
  }
  if (deps.includes("cache")) {
    lines.push("- `app.cache`: InMemoryCacheBackend() — the deterministic default adapter (wired as app.state.cache)")
  }
  if (deps.includes("messaging")) {
    lines.push("- `app.messaging`: InMemoryMessageBroker() — the deterministic default adapter (wired as app.state.messaging)")
  }
  if (deps.includes("blob")) {
    lines.push("- `app.blob`: InMemoryBlobStore() — the deterministic default adapter (wired as app.state.blob)")
  }
  if (deps.some((d) => d.startsWith("router:"))) {
    lines.push("- `app.router_registry`: ROUTERS — the compiler-owned ordered tuple of every sibling router; include exactly these entries in tuple order and never import a sibling router module directly")
  }
  return lines.join("\n")
}

function taskHeader(task: string, scope: string[], context: string[], bp: BackendBlueprint, deps: string[]): string {
  const slice = interfaceSlice(bp, deps)
  return `You are executing ONE TASK of a larger, compiler-planned generation.

# Task: ${task}

The specification compiler derived this task from the user's specification.

- Your scope (create/modify ONLY these): ${scope.join(", ")}
- Dependency files already in this workspace (read-only for you): ${
    context.length > 0 ? context.join(", ") : "—"
  }
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use \`/tmp\`). Never create \`.pkg-tmp\`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke \`pip\`, \`venv\`,
  \`git\`, shell redirection, pipes, \`cd\`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  \`uv run --no-project --with <pinned-package> ...\`; otherwise reason from
  the pinned contract and write only the owned files.

## Import surface (complete — compiled from the frozen blueprint)

These are the ONLY symbols outside your scope your task may rely on.
Consult a dependency file only when a clause needs a detail beyond a
signature; do not mine it for conventions.
${slice ? `\n${slice}\n` : "\n(You have no importable dependency modules; this task stands alone.)\n"}
## Reading discipline

Do NOT read \`conformance/\`, \`tests/spec_oracle/\`, \`.spec/\`, \`.spec-input/\`,
sibling router modules, or any file outside your scope and the dependency
files listed above — none of them are inputs to your decisions. Your
COMPLETE behavioral contract is the clause table below; anything it does
not state is implementation freedom, not something to discover by reading
other files.`
}

function clauseLines(clauses: ContractClause[]): string[] {
  return clauses.map((clause) => `- [${clause.id}]${clause.verification === "review" ? " (reviewer-judged)" : ""} ${clause.statement}`)
}

export interface RenderKernelInput {
  task: string
  scope: string[]
  context: string[]
  /** Dependency task ids — select the compiled import-slice lines. */
  deps: string[]
  clauses: ContractClause[]
  blueprint: BackendBlueprint
}

/** The role-shared half of every prompt: the clause table and its protocol. */
export function renderKernel(input: RenderKernelInput): string {
  const api = input.clauses.filter((clause) => clause.level === "api")
  const fn = input.clauses.filter((clause) => clause.level === "function")
  const hasRoutes = input.clauses.some((clause) => clause.kind === "route" || clause.kind === "transition")
  const hasAbi = input.clauses.some((clause) => clause.kind === "abi")
  const forbidden: string[] = []
  if (hasRoutes) forbidden.push("- No routes exist beyond the clause-listed interface of this task.")
  if (hasAbi) forbidden.push("- The module's public surface is exactly the declared export list — no additional APIs, registries, or framework code.")
  forbidden.push("- Files beyond your scope are never created or modified.")
  return `${taskHeader(input.task, input.scope, input.context, input.blueprint, input.deps)}

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
${clauseLines(api).join("\n")}
${fn.length > 0 ? `\n### function-level clauses\n${clauseLines(fn).join("\n")}` : ""}

## Forbidden extras
${forbidden.join("\n")}

${sharedOperationalConstraints(input.blueprint)}

${CHALLENGE_PROTOCOL}`
}

export interface RenderBriefInput {
  blueprint: BackendBlueprint
  taskKind: string
  dataBlocks: Array<{ title: string; json: unknown }>
  notes: string[]
}

/** The role-private half: engineering guidance and reference data. */
export function renderBrief(input: RenderBriefInput): string {
  const sections: string[] = []
  const guidance = guidanceSection(input.blueprint, input.taskKind)
  if (guidance) sections.push(guidance)
  if (input.dataBlocks.length > 0) {
    sections.push(
      [
        "## Reference data (subordinate to the clause table)",
        ...input.dataBlocks.flatMap((block) => [`### ${block.title}`, "```json", stableStringify(block.json), "```"]),
      ].join("\n"),
    )
  }
  if (input.notes.length > 0) {
    sections.push([`## Engineering notes`, ...input.notes.map((note) => `- ${note}`)].join("\n"))
  }
  return sections.join("\n\n")
}

/** The reviewer's projection of the clause table: machine clauses are
 * evidence-checked, review clauses are judged by inspection. */
export function reviewerPrompt(input: { task: string; clauses: ContractClause[] }): string {
  const oracle = input.clauses.filter((clause) => clause.verification !== "review")
  const review = input.clauses.filter((clause) => clause.verification === "review")
  return `You are the read-only reviewer for generation node ${JSON.stringify(input.task)}.
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
${oracle.map((clause) => `- [${clause.id}] ${clause.statement}`).join("\n") || "- (none)"}

## Reviewer-judged clauses (verify by inspection)
${review.map((clause) => `- [${clause.id}] ${clause.statement}`).join("\n") || "- (none)"}

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.`
}

export interface TaskPromptInput {
  blueprint: BackendBlueprint
  scope: string[]
  context: string[]
  deps: string[]
  clauses: ContractClause[]
}

function compose(kernel: RenderKernelInput, brief: RenderBriefInput): string {
  return `${renderKernel(kernel)}\n\n${renderBrief(brief)}`
}

export function projectPrompt(bp: BackendBlueprint, ctx: TaskPromptInput): string {
  return compose(
    { task: "project skeleton", scope: ctx.scope, context: ctx.context, deps: ctx.deps, clauses: ctx.clauses, blueprint: bp },
    {
      blueprint: bp,
      taskKind: "project",
      dataBlocks: [{ title: "App metadata", json: bp.app }],
      notes: ["pyproject.toml must be installable (hatchling or setuptools)."],
    },
  )
}

export function modelsPrompt(bp: BackendBlueprint, ctx: TaskPromptInput): string {
  const notes = [
    "One class per entity; a shared mixin for id/created_at is idiomatic.",
    "The uuid4 default may be Python-side; it must produce distinct ids per insert.",
  ]
  if (!bp.auth) notes.push("No auth in this specification: no password columns.")
  return compose(
    { task: "data models", scope: ctx.scope, context: ctx.context, deps: ctx.deps, clauses: ctx.clauses, blueprint: bp },
    {
      blueprint: bp,
      taskKind: "models",
      dataBlocks: [{ title: "Entities (the complete data model)", json: bp.entities }],
      notes,
    },
  )
}

export function databasePrompt(bp: BackendBlueprint, ctx: TaskPromptInput): string {
  return compose(
    { task: "database layer", scope: ctx.scope, context: ctx.context, deps: ctx.deps, clauses: ctx.clauses, blueprint: bp },
    {
      blueprint: bp,
      taskKind: "database",
      dataBlocks: [{ title: "Database contract", json: bp.database }],
      notes: [
        "Base is the one SQLAlchemy DeclarativeBase imported by models.",
        "Tables are created via Base.metadata.create_all(engine) at app startup (the app task wires this).",
      ],
    },
  )
}

export function schemasPrompt(bp: BackendBlueprint, ctx: TaskPromptInput): string {
  return compose(
    { task: "pydantic schemas", scope: ctx.scope, context: ctx.context, deps: ctx.deps, clauses: ctx.clauses, blueprint: bp },
    {
      blueprint: bp,
      taskKind: "schemas",
      dataBlocks: [{ title: "Entities", json: bp.entities.map((e) => ({ name: e.name, fields: e.fields })) }],
      notes: ["Response serialization is contract-critical; the clause table pins the exact key sets."],
    },
  )
}

export function securityPrompt(bp: BackendBlueprint, ctx: TaskPromptInput): string {
  return compose(
    { task: "auth security", scope: ctx.scope, context: ctx.context, deps: ctx.deps, clauses: ctx.clauses, blueprint: bp },
    {
      blueprint: bp,
      taskKind: "security",
      dataBlocks: [{ title: "Auth contract", json: { auth: bp.auth, unauthenticated: bp.contract.errors.unauthenticated } }],
      notes: ["JWT bearer tokens carry sub = principal id with secret/expiry via env."],
    },
  )
}

export function routerPrompt(
  bp: BackendBlueprint,
  ctx: TaskPromptInput,
  entityName: string,
): string {
  const entity = bp.entities.find((e) => e.name === entityName)!
  const transitions = bp.routes
    .filter((r) => r.operation === "transition" && r.entity === entityName && r.transition)
    .map((r) => ({
      event: r.transition!.event,
      path: r.path,
      ...(r.transition!.guard !== undefined ? { guard: r.transition!.guard } : {}),
      ...(r.transition!.effects !== undefined ? { effects: r.transition!.effects } : {}),
    }))
  const relevantInvariants = bp.invariants.filter((inv) =>
    bp.routes.some((r) => r.entity === entityName && r.invariantIds?.includes(inv.id)),
  )
  const dataBlocks: RenderBriefInput["dataBlocks"] = [{ title: "Entity", json: entity }]
  if (transitions.some((tr) => tr.guard !== undefined)) {
    dataBlocks.push({ title: "Guard expressions (data, from the specification)", json: transitions.filter((tr) => tr.guard !== undefined).map((tr) => ({ event: tr.event, guard: tr.guard })) })
  }
  if (transitions.some((tr) => Array.isArray(tr.effects) && tr.effects.length > 0)) {
    dataBlocks.push({ title: "Effects (data, applied inside the transition transaction in declared order)", json: transitions.filter((tr) => Array.isArray(tr.effects) && tr.effects.length > 0).map((tr) => ({ event: tr.event, effects: tr.effects })) })
  }
  if (relevantInvariants.length > 0) {
    dataBlocks.push({ title: "Invariant check trees (data, from the specification)", json: relevantInvariants.map((inv) => ({ id: inv.id, shape: inv.shape, check: inv.check, count: inv.count })) })
  }
  const notes = [
    "Use the schemas from `app/schemas.py` and the models from `app/models.py`.",
    "Guards evaluate `requestTime` (the request's receipt time, naive UTC) ONCE per request, bound into the SQL comparison — never baked into code.",
    "If a reference-validation helper needs a model-class type, use `type[Any]` (with `Any` from `typing`) or omit that annotation.",
  ]
  return compose(
    { task: `router: ${entityName}`, scope: ctx.scope, context: ctx.context, deps: ctx.deps, clauses: ctx.clauses, blueprint: bp },
    { blueprint: bp, taskKind: "router", dataBlocks, notes },
  )
}

export function authRouterPrompt(bp: BackendBlueprint, ctx: TaskPromptInput): string {
  const auth = bp.auth!
  const principal = bp.entities.find((e) => e.name === auth.principal)!
  return compose(
    { task: "router: auth", scope: ctx.scope, context: ctx.context, deps: ctx.deps, clauses: ctx.clauses, blueprint: bp },
    {
      blueprint: bp,
      taskKind: "router",
      dataBlocks: [
        { title: "Auth contract", json: auth },
        { title: "Principal entity", json: principal },
      ],
      notes: [],
    },
  )
}

export function appPrompt(bp: BackendBlueprint, ctx: TaskPromptInput): string {
  return compose(
    { task: "application wiring", scope: ctx.scope, context: ctx.context, deps: ctx.deps, clauses: ctx.clauses, blueprint: bp },
    {
      blueprint: bp,
      taskKind: "app",
      dataBlocks: [{ title: "Application", json: bp.app }],
      notes: ["Count routes must be reachable after inclusion (registration order comes from the compiler-owned registry tuple)."],
    },
  )
}

export function cachePrompt(bp: BackendBlueprint, ctx: TaskPromptInput): string {
  return compose(
    { task: "cache infrastructure", scope: ctx.scope, context: ctx.context, deps: ctx.deps, clauses: ctx.clauses, blueprint: bp },
    {
      blueprint: bp,
      taskKind: "cache",
      dataBlocks: [{ title: "Cache contract", json: bp.caches }],
      notes: [],
    },
  )
}

export function messagingPrompt(bp: BackendBlueprint, ctx: TaskPromptInput): string {
  return compose(
    { task: "messaging infrastructure", scope: ctx.scope, context: ctx.context, deps: ctx.deps, clauses: ctx.clauses, blueprint: bp },
    {
      blueprint: bp,
      taskKind: "messaging",
      dataBlocks: [{ title: "Messaging contract", json: { messages: bp.messages, queues: bp.queues } }],
      notes: [],
    },
  )
}

export function blobPrompt(bp: BackendBlueprint, ctx: TaskPromptInput): string {
  return compose(
    { task: "blob infrastructure", scope: ctx.scope, context: ctx.context, deps: ctx.deps, clauses: ctx.clauses, blueprint: bp },
    {
      blueprint: bp,
      taskKind: "blob",
      dataBlocks: [
        { title: "Blob contract", json: bp.blobs },
        { title: "Exact module ABI (the only source of parameter names and selector type)", json: bp.moduleAbis.blob },
      ],
      notes: [],
    },
  )
}
