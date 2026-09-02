import type { AgentExecutionAcceptance, AgentExecutionPlan, Diagnostic } from "@spec/core"
import { agentExecutionPlanFingerprint } from "./plan"

const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const OCI_DIGEST = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/
const CONTENT_HASH = /^(?:sha256:)?[a-f0-9]{64}$/
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function safeRef(value: string, singleSegment = false): boolean {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("..") || value.includes("@{") || value.includes("[") || /[\x00-\x20\x7f~^:?*\\]/.test(value)) return false
  const parts = value.split("/")
  if (singleSegment && parts.length !== 1) return false
  return parts.every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock") && SAFE_SEGMENT.test(part))
}

function diagnostic(code: string, message: string, details?: Record<string, unknown>): Diagnostic {
  return { code, level: "error", message, ...(details ? { details } : {}) }
}

function validateAcceptance(
  acceptance: AgentExecutionAcceptance,
  owner: string,
  diagnostics: Diagnostic[],
): void {
  if (!Array.isArray(acceptance.requiredChecks) || acceptance.requiredChecks.some((item) => typeof item !== "string" || item.length === 0)) {
    diagnostics.push(diagnostic("AGENT_EXECUTION_CHECK_INVALID", `${owner} requiredChecks must contain non-empty names.`))
  }
  if (new Set(acceptance.requiredChecks).size !== acceptance.requiredChecks.length) {
    diagnostics.push(diagnostic("AGENT_EXECUTION_CHECK_DUPLICATE", `${owner} requiredChecks must be unique.`))
  }
  if (!Array.isArray(acceptance.commands) || acceptance.commands.length === 0 || acceptance.commands.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    diagnostics.push(diagnostic("AGENT_EXECUTION_COMMAND_INVALID", `${owner} must declare at least one non-empty acceptance command.`))
  }
}

export function validateAgentExecutionPlan(plan: AgentExecutionPlan): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  if (plan.schemaVersion !== "spec-agent-execution-plan/0.1" || plan.graphKind !== "generation-execution") {
    diagnostics.push(diagnostic("AGENT_EXECUTION_SCHEMA_INVALID", "Agent execution plan schemaVersion/graphKind is unsupported."))
  }
  if (!safeRef(plan.runId, true)) diagnostics.push(diagnostic("AGENT_EXECUTION_RUN_ID_INVALID", "runId must be one safe Git ref segment."))
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(plan.repository)) diagnostics.push(diagnostic("AGENT_EXECUTION_REPOSITORY_INVALID", "repository must use owner/name form."))
  if (!safeRef(plan.defaultBranch)) diagnostics.push(diagnostic("AGENT_EXECUTION_DEFAULT_BRANCH_INVALID", "defaultBranch must be a safe Git branch name."))
  if (!safeRef(plan.branchPrefix)) diagnostics.push(diagnostic("AGENT_EXECUTION_BRANCH_PREFIX_INVALID", "branchPrefix must be a safe Git branch prefix."))
  if (!GIT_SHA.test(plan.rootBaseSha)) diagnostics.push(diagnostic("AGENT_EXECUTION_BASE_SHA_INVALID", "rootBaseSha must be a full 40- or 64-character lowercase Git SHA."))
  if (!OCI_DIGEST.test(plan.environment.image)) diagnostics.push(diagnostic("AGENT_EXECUTION_IMAGE_NOT_IMMUTABLE", "Agent environment image must be pinned by sha256 digest."))
  if (!CONTENT_HASH.test(plan.environment.devcontainerHash) || !CONTENT_HASH.test(plan.environment.toolchainLockHash)) {
    diagnostics.push(diagnostic("AGENT_EXECUTION_ENVIRONMENT_HASH_INVALID", "Environment definition and toolchain lock hashes must be sha256 digests."))
  }
  if (agentExecutionPlanFingerprint(plan) !== plan.fingerprint) diagnostics.push(diagnostic("AGENT_EXECUTION_FINGERPRINT_MISMATCH", "Agent execution plan fingerprint does not match its canonical definition."))
  validateAcceptance(plan.acceptance, "plan", diagnostics)

  const byId = new Map<string, AgentExecutionPlan["tasks"][number]>()
  for (const task of plan.tasks) {
    if (!safeRef(task.id, true)) diagnostics.push(diagnostic("AGENT_EXECUTION_TASK_ID_INVALID", `Task id "${task.id}" is not a safe Git ref segment.`, { task: task.id }))
    if (byId.has(task.id)) diagnostics.push(diagnostic("AGENT_EXECUTION_TASK_DUPLICATE", `Task id "${task.id}" is duplicated.`, { task: task.id }))
    else byId.set(task.id, task)
    if (task.objective.trim().length === 0 || task.instruction.trim().length === 0) diagnostics.push(diagnostic("AGENT_EXECUTION_TASK_INSTRUCTION_INVALID", `Task "${task.id}" needs an objective and instruction.`, { task: task.id }))
    if (task.executor === "materialize") {
      const files = task.materializedFiles
      if (!files || Object.keys(files).length === 0) {
        diagnostics.push(diagnostic("AGENT_EXECUTION_MATERIALIZATION_EMPTY", `Task "${task.id}" must contain compiler-owned materializedFiles.`, { task: task.id }))
      } else {
        const expected = new Set(task.scope)
        for (const file of Object.keys(files)) {
          const scoped = task.workingDirectory ? `${task.workingDirectory.replace(/\/$/, "")}/${file}` : file
          if (!expected.has(scoped)) diagnostics.push(diagnostic("AGENT_EXECUTION_MATERIALIZATION_SCOPE_INVALID", `Task "${task.id}" materializes "${file}" outside its scope.`, { task: task.id, file }))
        }
      }
    } else if (task.materializedFiles !== undefined) {
      diagnostics.push(diagnostic("AGENT_EXECUTION_MATERIALIZATION_UNEXPECTED", `Agent task "${task.id}" cannot contain materializedFiles.`, { task: task.id }))
    }
    if (task.workingDirectory && (task.workingDirectory.startsWith("/") || task.workingDirectory.startsWith("../") || task.workingDirectory.includes("/../") || /[*?{}[\]]/.test(task.workingDirectory))) {
      diagnostics.push(diagnostic("AGENT_EXECUTION_WORKDIR_INVALID", `Task "${task.id}" workingDirectory must be repository-relative.`, { task: task.id }))
    }
    if (task.scope.length === 0) diagnostics.push(diagnostic("AGENT_EXECUTION_SCOPE_EMPTY", `Task "${task.id}" must own at least one file.`, { task: task.id }))
    if (new Set(task.scope).size !== task.scope.length) diagnostics.push(diagnostic("AGENT_EXECUTION_SCOPE_DUPLICATE", `Task "${task.id}" contains duplicate scope entries.`, { task: task.id }))
    for (const file of task.scope) {
      if (file.startsWith("/") || file.startsWith("../") || file.includes("/../") || file === "." || /[*?{}[\]]/.test(file)) {
        diagnostics.push(diagnostic("AGENT_EXECUTION_SCOPE_INVALID", `Task "${task.id}" scope must contain exact repository-relative file paths; received "${file}".`, { task: task.id, file }))
      }
    }
    if (task.acceptance) validateAcceptance(task.acceptance, `task "${task.id}"`, diagnostics)
  }

  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) diagnostics.push(diagnostic("AGENT_EXECUTION_DEPENDENCY_UNKNOWN", `Task "${task.id}" depends on unknown task "${dependency}".`, { task: task.id, dependency }))
      if (dependency === task.id) diagnostics.push(diagnostic("AGENT_EXECUTION_DEPENDENCY_CYCLE", `Task "${task.id}" depends on itself.`, { task: task.id }))
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  let cycleReported = false
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      if (!cycleReported) diagnostics.push(diagnostic("AGENT_EXECUTION_DEPENDENCY_CYCLE", "Agent execution graph contains a cycle."))
      cycleReported = true
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) if (byId.has(dependency)) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of [...byId.keys()].sort()) visit(id)

  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true
    if (seen.has(from)) return false
    seen.add(from)
    return (byId.get(from)?.dependsOn ?? []).some((dependency) => reaches(dependency, target, seen))
  }
  const tasks = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex++) {
      const left = tasks[leftIndex]
      const right = tasks[rightIndex]
      const overlap = left.scope.filter((file) => right.scope.includes(file)).sort()
      if (overlap.length > 0 && !reaches(left.id, right.id) && !reaches(right.id, left.id)) {
        diagnostics.push(diagnostic(
          "AGENT_EXECUTION_SCOPE_OVERLAP_UNORDERED",
          `Independent tasks "${left.id}" and "${right.id}" both own ${overlap.join(", ")}; add an ordering edge or split the scope.`,
          { tasks: [left.id, right.id], files: overlap },
        ))
      }
    }
  }
  return diagnostics
}
