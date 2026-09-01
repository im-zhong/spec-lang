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
import type { SpecIR } from "@spec/core"
import { stableStringify } from "@spec/core"
import type { BackendBlueprint } from "./blueprint"
import {
  appPrompt,
  authRouterPrompt,
  databasePrompt,
  modelsPrompt,
  projectPrompt,
  routerPrompt,
  schemasPrompt,
  securityPrompt,
  type TaskPromptInput,
} from "./prompt"

export interface DagTask {
  id: string
  label: string
  dependsOn: string[]
  /** Files this task owns (create/modify). */
  scope: string[]
  /** Deterministic prompt (pure function of the blueprint). */
  prompt: string
  /** Spec nodes this task derives from (provenance). */
  specNodeIds: string[]
}

export interface GenerationDag {
  blueprint: BackendBlueprint
  /** Topologically sorted. */
  tasks: DagTask[]
  edges: Array<{ from: string; to: string }>
}

function irNodeIds(ir: SpecIR): string[] {
  return ir.nodes.map((n) => n.id).filter((id) => /^(app|entity|crud|auth|api|fastapi|postgres):/.test(id)).sort()
}

export function buildTaskDag(bp: BackendBlueprint, ir: SpecIR): GenerationDag {
  const all = irNodeIds(ir)
  const entityIds = (names: string[]): string[] =>
    names.map((n) => `entity:${n}`).filter((id) => all.includes(id)).sort()

  const tasks: DagTask[] = []
  const ctx = (scope: string[], context: string[]): TaskPromptInput => ({ blueprint: bp, scope, context })

  /* ---- project skeleton (root) ---- */
  tasks.push({
    id: "project",
    label: "project skeleton",
    dependsOn: [],
    scope: ["pyproject.toml", "app/__init__.py", ".gitignore"],
    prompt: projectPrompt(bp, ctx(["pyproject.toml", "app/__init__.py", ".gitignore"], [])),
    specNodeIds: all.filter((id) => id.startsWith("app:")),
  })

  /* ---- data models ---- */
  tasks.push({
    id: "models",
    label: "data models",
    dependsOn: ["project"],
    scope: ["app/models.py"],
    prompt: modelsPrompt(bp, ctx(["app/models.py"], ["app/__init__.py"])),
    specNodeIds: entityIds(bp.entities.map((e) => e.name)),
  })

  /* ---- database layer ---- */
  tasks.push({
    id: "database",
    label: "database layer",
    dependsOn: ["project"],
    scope: ["app/config.py", "app/database.py"],
    prompt: databasePrompt(bp, ctx(["app/config.py", "app/database.py"], ["app/__init__.py"])),
    specNodeIds: all.filter((id) => id.startsWith("postgres:")),
  })

  /* ---- pydantic schemas ---- */
  tasks.push({
    id: "schemas",
    label: "pydantic schemas",
    dependsOn: ["models"],
    scope: ["app/schemas.py"],
    prompt: schemasPrompt(bp, ctx(["app/schemas.py"], ["app/models.py"])),
    specNodeIds: entityIds(bp.entities.map((e) => e.name)),
  })

  /* ---- security (auth only) ---- */
  if (bp.auth) {
    tasks.push({
      id: "security",
      label: "auth security",
      dependsOn: ["models", "database"],
      scope: ["app/security.py", "app/deps.py"],
      prompt: securityPrompt(bp, ctx(["app/security.py", "app/deps.py"], ["app/models.py", "app/database.py"])),
      specNodeIds: all.filter((id) => id.startsWith("auth:")),
    })
  }

  /* ---- one router per served entity (crud and/or count) ---- */
  const servedEntities = [...new Set(bp.routes.filter((r) => r.entity).map((r) => r.entity!))].sort()
  const baseRouterDeps = ["models", "schemas", "database"]
  for (const entityName of servedEntities) {
    const routes = bp.routes.filter((r) => r.entity === entityName)
    const needsAuth = routes.some((r) => r.auth) || (bp.auth?.principal === entityName)
    const deps = [...baseRouterDeps, ...(needsAuth && bp.auth ? ["security"] : [])]
    const file = routerFile(entityName)
    tasks.push({
      id: `router:${entityName}`,
      label: `router: ${entityName}`,
      dependsOn: deps,
      scope: [file],
      prompt: routerPrompt(
        bp,
        ctx([file], contextFor(deps)),
        entityName,
      ),
      specNodeIds: [...(all.includes(`crud:${entityName}`) ? [`crud:${entityName}`] : []),
        ...all.filter((id) => id.startsWith("api:") && routes.some((r) => r.operation === "count"))],
    })
  }

  /* ---- auth router ---- */
  if (bp.auth) {
    tasks.push({
      id: "router:auth",
      label: "router: auth",
      dependsOn: ["models", "schemas", "database", "security"],
      scope: ["app/routers/auth.py"],
      prompt: authRouterPrompt(bp, ctx(["app/routers/auth.py"], contextFor(["models", "schemas", "security"]))),
      specNodeIds: all.filter((id) => id.startsWith("auth:")),
    })
  }

  /* ---- application wiring (sink) ---- */
  const appDeps = [...tasks.filter((t) => t.id.startsWith("router:")).map((t) => t.id), "database"]
  tasks.push({
    id: "app",
    label: "application wiring",
    dependsOn: appDeps,
    scope: ["app/main.py"],
    prompt: appPrompt(bp, ctx(["app/main.py"], contextFor(appDeps))),
    specNodeIds: all.filter((id) => id.startsWith("fastapi:") || id.startsWith("app:")),
  })

  /* ---- order & validate ---- */
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
      label: t.label,
      dependsOn: [...t.dependsOn].sort(),
      scope: t.scope,
      prompt: t.prompt,
      specNodeIds: t.specNodeIds,
    })),
    edges: dag.edges,
  })
}
