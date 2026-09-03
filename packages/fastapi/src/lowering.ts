/**
 * Agentic lowering: Spec IR → generation plan.
 *
 * This is the bridge between the two halves of the compiler:
 *
 *   traditional half:  .spec.ts → passes → Spec IR → blueprint (pure)
 *   agentic half:      DAG of generation tasks → agent harness → workspace
 *                      → compiler-owned conformance (NO repair)
 *
 * The plan is DETERMINISTIC: the same IR always lowers to the same DAG
 * (same tasks, same edges, same prompts — byte-stable fingerprint), the
 * same conformance suite and the same verification commands. There is no
 * repair loop: if a shot does not conform on its FIRST verification, the
 * specification/blueprint is under-pinned and must be fixed, then all
 * shots regenerated.
 */
import type { AgentTask, Constraint, SpecIR } from "@spec/core"
import { stableStringify } from "@spec/core"
import { buildBlueprint, type BackendBlueprint } from "./blueprint"
import { buildConformanceSuite, type ConformanceFiles } from "./conformance"
import { buildTaskDag, dagFingerprint, type GenerationDag } from "./dag"
import { fastApiVerification, type VerificationPlan } from "./verify"

export interface FastApiGenerationPlan {
  blueprint: BackendBlueprint
  /** Dependency-structured generation tasks (topologically sorted). */
  dag: GenerationDag
  /** Core AgentTask view of the DAG (for agent.tasks.json). */
  agentTasks: AgentTask[]
  /** Compiler-owned conformance files written into the workspace. */
  conformance: ConformanceFiles
  /** Deterministic verification executed by the orchestrator. */
  verification: VerificationPlan
  /** Compiler-owned mechanical files available before any agent task. */
  seedFiles: Record<string, string>
  /** Deterministic byte-stable form (DAG + prompts included). */
  stable: string
}

export function planGeneration(ir: SpecIR): FastApiGenerationPlan {
  const blueprint = buildBlueprint(ir)
  const dag = buildTaskDag(blueprint, ir)
  const conformance = buildConformanceSuite(blueprint)
  const verification = fastApiVerification()
  const routerTasks = [...new Set(blueprint.routes.map((route) => route.owner.taskId))].sort()
  const imports = routerTasks.map((taskId) => {
    const suffix = taskId.slice("router:".length).toLowerCase()
    const alias = `router_${suffix.replace(/[^a-z0-9_]/g, "_")}`
    return { line: `from app.routers.${suffix} import router as ${alias}`, alias }
  })
  const seedFiles = {
    "app/router_registry.py": [
      '"""Compiler-owned router registry — DO NOT EDIT."""',
      "",
      ...imports.map((item) => item.line),
      "",
      `ROUTERS = (${imports.map((item) => item.alias).join(", ")}${imports.length === 1 ? "," : ""})`,
      "",
    ].join("\n"),
  }

  const constraints: Constraint[] = [
    { kind: "interface", value: blueprint.routes.map((r) => r.id).sort() },
    { kind: "serialization", value: blueprint.contract.serialization },
    { kind: "errors", value: blueprint.contract.errors },
    {
      kind: "entrypoint",
      value: "app/main.py must export create_app(database_url: str | None = None) and app = create_app()",
    },
    {
      kind: "no-repair",
      value: "shots must pass conformance on the FIRST verification; failures indicate an under-pinned specification",
    },
    {
      kind: "conformance",
      value: "the compiler drops conformance/ into the workspace — never create or modify it",
    },
  ]

  const agentTasks: AgentTask[] = dag.tasks.map((task) => ({
    id: task.id,
    type: "generate",
    input: {
      scope: task.scope,
      dependsOn: task.dependsOn,
      loop: task.loop,
      acceptanceCommands: task.acceptanceCommands,
    },
    constraints,
    context: { specNodeIds: task.specNodeIds },
  }))

  return {
    blueprint,
    dag,
    agentTasks,
    conformance,
    verification,
    seedFiles,
    stable: stableStringify({
      blueprint,
      dag: JSON.parse(dagFingerprint(dag)),
      verification,
      seedFiles,
      conformance: conformance.files,
    }),
  }
}
