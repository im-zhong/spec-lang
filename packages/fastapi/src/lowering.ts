/**
 * Agentic lowering: Spec IR → generation plan.
 *
 * This is the bridge between the two halves of the compiler:
 *
 *   traditional half:  .spec.ts → passes → Spec IR → blueprint (pure)
 *   agentic half:      plan.tasks → coding agent → workspace → conformance
 *
 * The plan is DETERMINISTIC: the same IR always lowers to the same task
 * list, the same prompts, the same conformance suite and the same
 * verification commands. Nondeterminism is confined to the agent's code,
 * and the conformance suite pins its observable behavior (golden rule).
 */
import type { AgentTask, Constraint, SpecIR } from "@spec/core"
import { stableStringify } from "@spec/core"
import { buildBlueprint, type BackendBlueprint } from "./blueprint"
import { buildConformanceSuite, type ConformanceFiles } from "./conformance"
import { implementPrompt, repairPrompt } from "./prompt"
import { fastApiVerification, type VerificationPlan } from "./verify"

export interface FastApiGenerationPlan {
  blueprint: BackendBlueprint
  /** Ordered agent tasks (deterministic ids). */
  tasks: AgentTask[]
  /** Compiler-owned conformance files written into the workspace. */
  conformance: ConformanceFiles
  /** Deterministic verification executed by the orchestrator. */
  verification: VerificationPlan
  /** Deterministic byte-stable form (task contract, prompts included). */
  stable: string
}

export function planGeneration(ir: SpecIR): FastApiGenerationPlan {
  const blueprint = buildBlueprint(ir)
  const conformance = buildConformanceSuite(blueprint)
  const verification = fastApiVerification()

  const specNodeIds = ir.nodes
    .map((node) => node.id)
    .filter((id) =>
      /^(app:|entity:|crud:|auth:|fastapi:|api:)/.test(id),
    )
    .sort()

  const constraints: Constraint[] = [
    { kind: "interface", value: blueprint.routes.map((r) => r.id).sort() },
    { kind: "serialization", value: blueprint.contract.serialization },
    { kind: "errors", value: blueprint.contract.errors },
    {
      kind: "entrypoint",
      value: "app/main.py must export create_app(database_url: str | None = None) and app = create_app()",
    },
    {
      kind: "tooling",
      value: "pyproject.toml with a dev extra providing pytest and httpx; project installable via uv pip install -e '.[dev]'",
    },
    {
      kind: "conformance",
      value: "the compiler drops conformance/ into the workspace — never create or modify it",
    },
  ]

  const tasks: AgentTask[] = [
    {
      id: "fastapi:implement",
      type: "generate",
      input: { blueprint },
      constraints,
      context: { specNodeIds },
    },
    {
      id: "fastapi:conform",
      type: "verify",
      input: {
        commands: [...verification.setup, ...verification.check].map((c) => c.command),
        suite: Object.keys(conformance.files).sort(),
      },
      constraints: [{ kind: "golden-rule", value: "all conformance tests must pass" }],
      context: { specNodeIds },
    },
  ]

  return {
    blueprint,
    tasks,
    conformance,
    verification,
    stable: stableStringify({
      blueprint,
      tasks: tasks.map((t) => ({
        id: t.id,
        type: t.type,
        constraints: t.constraints,
        context: t.context,
        input: t.id === "fastapi:implement" ? "<blueprint>" : t.input,
      })),
      prompts: { implement: implementPrompt(blueprint), repair: "<failure-output>" },
      verification,
      conformance: conformance.files,
    }),
  }
}
