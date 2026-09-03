import { createHash } from "node:crypto"
import { stableStringify, type AgentExecutionPlan, type AgentExecutionTask } from "@spec/core"

export interface AgentExecutionPlanInput {
  runId: string
  repository: string
  defaultBranch?: string
  rootBaseSha: string
  branchPrefix?: string
  environment: AgentExecutionPlan["environment"]
  acceptance: AgentExecutionPlan["acceptance"]
  mergePolicy?: AgentExecutionPlan["mergePolicy"]
  tasks: AgentExecutionTask[]
}

function canonicalTask(task: AgentExecutionTask): AgentExecutionTask {
  return {
    id: task.id,
    objective: task.objective,
    instruction: task.instruction,
    ...(task.executor ? { executor: task.executor } : {}),
    ...(task.materializedFiles ? {
      materializedFiles: Object.fromEntries(Object.entries(task.materializedFiles).sort(([left], [right]) => left.localeCompare(right))),
    } : {}),
    dependsOn: [...task.dependsOn].sort(),
    ...(task.workingDirectory ? { workingDirectory: task.workingDirectory } : {}),
    scope: [...task.scope].sort(),
    specNodeIds: [...task.specNodeIds].sort(),
    ...(task.acceptance ? {
      acceptance: {
        requiredChecks: [...task.acceptance.requiredChecks].sort(),
        commands: [...task.acceptance.commands],
      },
    } : {}),
  }
}

export function createAgentExecutionPlan(input: AgentExecutionPlanInput): AgentExecutionPlan {
  const definition = {
    schemaVersion: "spec-agent-execution-plan/0.1" as const,
    graphKind: "generation-execution" as const,
    runId: input.runId,
    repository: input.repository,
    defaultBranch: input.defaultBranch ?? "main",
    rootBaseSha: input.rootBaseSha,
    branchPrefix: (input.branchPrefix ?? "spec/generate").replace(/\/$/, ""),
    environment: {
      image: input.environment.image,
      devcontainerHash: input.environment.devcontainerHash,
      toolchainLockHash: input.environment.toolchainLockHash,
      agent: {
        model: input.environment.agent.model,
        effort: input.environment.agent.effort,
        maxTurns: input.environment.agent.maxTurns,
        maxConcurrency: input.environment.agent.maxConcurrency,
      },
    },
    acceptance: {
      requiredChecks: [...input.acceptance.requiredChecks].sort(),
      commands: [...input.acceptance.commands],
    },
    mergePolicy: input.mergePolicy ?? "pull-request" as const,
    tasks: input.tasks.map(canonicalTask).sort((left, right) => left.id.localeCompare(right.id)),
  }
  return {
    ...definition,
    fingerprint: `sha256:${createHash("sha256").update(stableStringify(definition)).digest("hex")}`,
  }
}

export function agentExecutionPlanFingerprint(plan: AgentExecutionPlan): string {
  const { fingerprint: _fingerprint, ...definition } = plan
  return `sha256:${createHash("sha256").update(stableStringify(definition)).digest("hex")}`
}

export function taskBranch(plan: AgentExecutionPlan, taskId: string): string {
  return `${plan.branchPrefix}/${plan.runId}/${taskId}`
}

export function taskBaseRef(plan: AgentExecutionPlan, taskId: string): string {
  return `${plan.branchPrefix}/${plan.runId}/bases/${taskId}`
}

/** Immutable GitHub control-plane ref containing only canonical plan.json. */
export function agentExecutionPlanRef(plan: Pick<AgentExecutionPlan, "branchPrefix" | "runId">): string {
  return `${plan.branchPrefix}/${plan.runId}/plan`
}
