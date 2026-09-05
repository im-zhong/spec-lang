/**
 * Generation DAG: Spec IR → dependency-structured generation plan.
 *
 * Code has structure, so generation has structure. The compiler derives a
 * DAG of narrowly-scoped generation tasks from the blueprint:
 *
 *                 project
 *                 /     \
 *            models     database
 *              |  \        |
 *          schemas \       |
 *              |   security (auth)
 *              |    /   |
 *        router:<entity> for each served entity   router:auth
 *                    \        |
 *                      app (wiring)
 *
 * Every task prompt is a pure function of its blueprint slice; every task
 * owns an explicit file scope; dependencies are data dependencies the
 * agent can literally read. The harness (@spec/agent) executes tasks in
 * topological order — one agent run per node.
 */
import type { AgentExecutionLoop, ContractClause, SpecIR } from "@spec/core"
import { stableStringify } from "@spec/core"
import type { BackendBlueprint } from "./blueprint"
import { clausesByTask } from "./clauses"
import { ORACLE_DIR, oracleFileFor, testCommandFor } from "./oracle"
import {
  appPrompt,
  authRouterPrompt,
  blobPrompt,
  cachePrompt,
  databasePrompt,
  messagingPrompt,
  modelsPrompt,
  projectPrompt,
  reviewerPrompt,
  routerPrompt,
  schemasPrompt,
  securityPrompt,
  type TaskPromptInput,
} from "./prompt"

export interface DagTask {
  id: string
  /** Stable target-defined kind used to select package guidance. */
  kind: string
  label: string
  dependsOn: string[]
  /** Files this task owns (create/modify). */
  scope: string[]
  /** Deterministic prompt (pure function of the blueprint). */
  prompt: string
  /** The node's machine-addressable contract (see clauses.ts). */
  clauses: ContractClause[]
  /** Spec nodes this task derives from (provenance). */
  specNodeIds: string[]
  loop?: AgentExecutionLoop
  acceptanceCommands?: string[]
}

export interface GenerationDag {
  blueprint: BackendBlueprint
  /** Topologically sorted. */
  tasks: DagTask[]
  edges: Array<{ from: string; to: string }>
}

function irNodeIds(ir: SpecIR): string[] {
  return ir.nodes.map((n) => n.id).sort()
}

function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildTaskDag(bp: BackendBlueprint, ir: SpecIR): GenerationDag {
  const all = irNodeIds(ir)
  const entityIds = (names: string[]): string[] =>
    names.map((n) => `entity:${n}`).filter((id) => all.includes(id)).sort()

  const tasks: DagTask[] = []
  const clauses = clausesByTask(bp)
  const taskClauses = (node: string): ContractClause[] => clauses.get(node) ?? []
  const ctx = (scope: string[], context: string[], node: string, deps: string[] = []): TaskPromptInput =>
    ({ blueprint: bp, scope, context, deps, clauses: taskClauses(node) })

  /* ---- project skeleton (root) ---- */
  tasks.push({
    id: "project",
    kind: "project",
    label: "project skeleton",
    dependsOn: [],
    scope: ["pyproject.toml", "app/__init__.py", ".gitignore"],
    prompt: projectPrompt(bp, ctx(["pyproject.toml", "app/__init__.py", ".gitignore"], [], "project")),
    clauses: taskClauses("project"),
    specNodeIds: all.filter((id) => id.startsWith("app:")),
  })

  /* ---- data models ---- */
  tasks.push({
    id: "models",
    kind: "models",
    label: "data models",
    dependsOn: ["project"],
    scope: ["app/models.py"],
    prompt: modelsPrompt(bp, ctx(["app/models.py"], ["app/__init__.py"], "models", ["project"])),
      clauses: taskClauses("models"),
    specNodeIds: entityIds(bp.entities.map((e) => e.name)),
  })

  /* ---- database layer ---- */
  tasks.push({
    id: "database",
    kind: "database",
    label: "database layer",
    dependsOn: ["project"],
    scope: ["app/config.py", "app/database.py"],
    prompt: databasePrompt(bp, ctx(["app/config.py", "app/database.py"], ["app/__init__.py"], "database", ["project"])),
      clauses: taskClauses("database"),
    specNodeIds: all.filter((id) => id.startsWith("postgres:")),
  })

  /* ---- pydantic schemas ---- */
  tasks.push({
    id: "schemas",
    kind: "schemas",
    label: "pydantic schemas",
    dependsOn: ["models"],
    scope: ["app/schemas.py"],
    prompt: schemasPrompt(bp, ctx(["app/schemas.py"], ["app/models.py"], "schemas", ["models"])),
      clauses: taskClauses("schemas"),
    specNodeIds: entityIds(bp.entities.map((e) => e.name)),
  })

  /* ---- security (auth only) ---- */
  if (bp.auth) {
    tasks.push({
      id: "security",
      kind: "security",
      label: "auth security",
      dependsOn: ["models", "database"],
      scope: ["app/security.py", "app/deps.py"],
      prompt: securityPrompt(bp, ctx(["app/security.py", "app/deps.py"], ["app/models.py", "app/database.py"], "security", ["models", "database"])),
      clauses: taskClauses("security"),
      specNodeIds: all.filter((id) => id.startsWith("auth:")),
    })
  }

  /* ---- one router per served entity (crud and/or count) ---- */
  const servedEntities = [...new Set(
    bp.routes.filter((route) => route.owner.taskId !== "router:auth" && route.entity).map((route) => route.entity!),
  )].sort()
  const baseRouterDeps = ["models", "schemas", "database"]
  for (const entityName of servedEntities) {
    const taskId = `router:${entityName}`
    const routes = bp.routes.filter((route) => route.owner.taskId === taskId)
    const needsAuth = routes.some((r) => r.auth) || (bp.auth?.principal === entityName)
    const deps = [...baseRouterDeps, ...(needsAuth && bp.auth ? ["security"] : [])]
    const file = routerFile(entityName)
    tasks.push({
      id: taskId,
      kind: "router",
      label: `router: ${entityName}`,
      dependsOn: deps,
      scope: [file],
      prompt: routerPrompt(
        bp,
        ctx([file], contextFor(deps), taskId, deps),
        entityName,
      ),
      clauses: taskClauses(taskId),
      specNodeIds: [...new Set(routes.map((route) => route.owner.sourceNodeId))].sort(),
    })
  }

  /* ---- auth router ---- */
  if (bp.auth) {
    tasks.push({
      id: "router:auth",
      kind: "router",
      label: "router: auth",
      dependsOn: ["models", "schemas", "database", "security"],
      scope: ["app/routers/auth.py"],
      prompt: authRouterPrompt(bp, ctx(["app/routers/auth.py"], contextFor(["models", "schemas", "security", "database"]), "router:auth", ["models", "schemas", "database", "security"])),
      clauses: taskClauses("router:auth"),
      specNodeIds: all.filter((id) => id.startsWith("auth:")),
    })
  }

  /* ---- infrastructure adapters ---- */
  if (bp.caches.length > 0) {
    tasks.push({
      id: "cache",
      kind: "cache",
      label: "cache infrastructure",
      dependsOn: ["project"],
      scope: ["app/cache.py"],
      prompt: cachePrompt(bp, ctx(["app/cache.py"], ["app/__init__.py"], "cache", ["project"])),
      clauses: taskClauses("cache"),
      specNodeIds: all.filter((id) => id.startsWith("cache:") || id.startsWith("redis:")),
    })
  }
  if (bp.queues.length > 0) {
    tasks.push({
      id: "messaging",
      kind: "messaging",
      label: "messaging infrastructure",
      dependsOn: ["project"],
      scope: ["app/messaging.py"],
      prompt: messagingPrompt(bp, ctx(["app/messaging.py"], ["app/__init__.py"], "messaging", ["project"])),
      clauses: taskClauses("messaging"),
      specNodeIds: all.filter((id) => /^(message|queue|rabbitmq|kafka|sqs):/.test(id)),
    })
  }
  if (bp.blobs.length > 0) {
    tasks.push({
      id: "blob",
      kind: "blob",
      label: "blob infrastructure",
      dependsOn: ["project"],
      scope: ["app/blob.py"],
      prompt: blobPrompt(bp, ctx(["app/blob.py"], ["app/__init__.py"], "blob", ["project"])),
      clauses: taskClauses("blob"),
      specNodeIds: all.filter((id) => id.startsWith("blob:") || id.startsWith("s3:")),
    })
  }

  /* ---- application wiring (sink) ---- */
  const infrastructureDeps = ["cache", "messaging", "blob"].filter((id) =>
    tasks.some((task) => task.id === id),
  )
  const appDeps = [
    ...tasks.filter((t) => t.id.startsWith("router:")).map((t) => t.id),
    "database",
    ...infrastructureDeps,
  ]
  tasks.push({
    id: "app",
    kind: "app",
    label: "application wiring",
    dependsOn: appDeps,
    scope: ["app/main.py"],
    prompt: appPrompt(bp, ctx(["app/main.py"], contextFor(appDeps), "app", appDeps)),
    clauses: taskClauses("app"),
    specNodeIds: all.filter((id) => id.startsWith("fastapi:") || id.startsWith("app:")),
  })

  /* ---- order & validate ---- */
  const taskIds = new Set(tasks.map((task) => task.id))
  const routeIds = new Set<string>()
  for (const route of bp.routes) {
    if (routeIds.has(route.id)) throw new Error(`backend blueprint has duplicate route id: ${route.id}`)
    routeIds.add(route.id)
    if (!taskIds.has(route.owner.taskId)) {
      throw new Error(`route ${route.id} has no producing task: ${route.owner.taskId}`)
    }
  }
  const packages = Object.entries({ ...bp.stack.dependencies, ...bp.stack.dev })
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, version]) => ["--with", shellWord(`${name}==${version}`)])
  for (const task of tasks) {
    const oracleCommand = testCommandFor(bp, oracleFileFor(task.id))
    task.loop = {
      schemaVersion: "spec-agent-task-loop/0.2",
      maxRounds: 3,
      implementation: { instruction: task.prompt, scope: [...task.scope] },
      reviewer: {
        commands: [oracleCommand],
        instruction: reviewerPrompt({ task: task.id, clauses: task.clauses }),
        oracleFiles: [oracleFileFor(task.id), `${ORACLE_DIR}/runner.py`].sort(),
        clauses: task.clauses,
      },
    }
    // This gate is outside the synthesis loop. Failure is the node's single
    // compiler-owned judgment and must never be fed back as a repair prompt.
    // The command runs the compiler-generated oracle, not any agent-authored
    // test file: the judgment itself is deterministic across shots.
    task.acceptanceCommands = [oracleCommand]
  }
  const ordered = topologicalSort(tasks)
  const edges: GenerationDag["edges"] = []
  for (const task of ordered) {
    for (const dep of task.dependsOn) edges.push({ from: dep, to: task.id })
  }
  return { blueprint: bp, tasks: ordered, edges }
}

function routerFile(entityName: string): string {
  return `app/routers/${entityName.toLowerCase()}.py`
}

/** File context contributed by completed dependency tasks. */
function contextFor(depIds: string[]): string[] {
  const scopeByTask: Record<string, string[]> = {
    project: ["pyproject.toml", "app/__init__.py"],
    models: ["app/models.py"],
    database: ["app/config.py", "app/database.py"],
    schemas: ["app/schemas.py"],
    security: ["app/security.py", "app/deps.py"],
    cache: ["app/cache.py"],
    messaging: ["app/messaging.py"],
    blob: ["app/blob.py"],
    "router:auth": ["app/routers/auth.py"],
  }
  const files: string[] = []
  for (const dep of depIds) {
    if (scopeByTask[dep]) files.push(...scopeByTask[dep])
    else if (dep.startsWith("router:")) files.push(`app/routers/${dep.slice("router:".length).toLowerCase()}.py`)
  }
  return [...new Set(files)].sort()
}

/** Deterministic topological sort (Kahn's algorithm, stable by id). */
export function topologicalSort(tasks: DagTask[]): DagTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const pending = new Set(tasks.map((t) => t.id))
  const done = new Set<string>()
  const out: DagTask[] = []
  while (pending.size > 0) {
    const ready = [...pending]
      .filter((id) => byId.get(id)!.dependsOn.every((d) => done.has(d)))
      .sort()
    if (ready.length === 0) {
      throw new Error(`generation DAG has a cycle involving: ${[...pending].sort().join(", ")}`)
    }
    for (const id of ready) {
      out.push(byId.get(id)!)
      done.add(id)
      pending.delete(id)
    }
  }
  return out
}

/** Byte-stable fingerprint of the whole DAG (prompts included). */
export function dagFingerprint(dag: GenerationDag): string {
  return stableStringify({
    tasks: dag.tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      label: t.label,
      dependsOn: [...t.dependsOn].sort(),
      scope: t.scope,
      prompt: t.prompt,
      clauses: t.clauses,
      specNodeIds: t.specNodeIds,
      loop: t.loop,
      acceptanceCommands: t.acceptanceCommands,
    })),
    edges: dag.edges,
  })
}
