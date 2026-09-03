import { describe, expect, it } from "vitest"
import { createAgentExecutionPlan, agentExecutionPlanFingerprint, validateAgentExecutionPlan } from "../src"

const SHA = "a".repeat(40)
const HASH = "b".repeat(64)
const IMAGE = `registry.example.com/spec-dev@sha256:${"c".repeat(64)}`

function plan(tasks = [
  { id: "api", objective: "API", instruction: "Build API", dependsOn: [], scope: ["src/api.ts"], specNodeIds: [] },
]) {
  return createAgentExecutionPlan({
    runId: "run-1",
    repository: "owner/repo",
    rootBaseSha: SHA,
    environment: {
      image: IMAGE,
      devcontainerHash: HASH,
      toolchainLockHash: HASH,
      agent: { model: "test-model", effort: "high", maxTurns: 20, maxConcurrency: 2 },
    },
    acceptance: { requiredChecks: ["test"], commands: ["pnpm test"] },
    tasks,
  })
}

describe("agent execution plan", () => {
  it("is canonical and byte-stable", () => {
    const first = plan()
    const second = plan()
    expect(first).toEqual(second)
    expect(first.fingerprint).toBe(agentExecutionPlanFingerprint(first))
    expect(validateAgentExecutionPlan(first)).toEqual([])
  })

  it("rejects unknown dependencies and cycles", () => {
    const unknown = plan([{ id: "api", objective: "API", instruction: "x", dependsOn: ["missing"], scope: ["a"], specNodeIds: [] }])
    expect(validateAgentExecutionPlan(unknown).map((item) => item.code)).toContain("AGENT_EXECUTION_DEPENDENCY_UNKNOWN")
    const cycle = plan([
      { id: "a", objective: "A", instruction: "x", dependsOn: ["b"], scope: ["a"], specNodeIds: [] },
      { id: "b", objective: "B", instruction: "x", dependsOn: ["a"], scope: ["b"], specNodeIds: [] },
    ])
    expect(validateAgentExecutionPlan(cycle).map((item) => item.code)).toContain("AGENT_EXECUTION_DEPENDENCY_CYCLE")
  })

  it("requires frozen agent settings in the plan fingerprint", () => {
    const value = plan()
    value.environment.agent.maxTurns = 0
    const codes = validateAgentExecutionPlan(value).map((item) => item.code)
    expect(codes).toContain("AGENT_EXECUTION_AGENT_ENVIRONMENT_INVALID")
    expect(codes).toContain("AGENT_EXECUTION_FINGERPRINT_MISMATCH")
  })

  it("rejects overlapping independent write scopes", () => {
    const value = plan([
      { id: "a", objective: "A", instruction: "x", dependsOn: [], scope: ["same.ts"], specNodeIds: [] },
      { id: "b", objective: "B", instruction: "x", dependsOn: [], scope: ["same.ts"], specNodeIds: [] },
    ])
    expect(validateAgentExecutionPlan(value).map((item) => item.code)).toContain("AGENT_EXECUTION_SCOPE_OVERLAP_UNORDERED")
  })

  it("allows overlap when the graph explicitly orders the writers", () => {
    const value = plan([
      { id: "a", objective: "A", instruction: "x", dependsOn: [], scope: ["same.ts"], specNodeIds: [] },
      { id: "b", objective: "B", instruction: "x", dependsOn: ["a"], scope: ["same.ts"], specNodeIds: [] },
    ])
    expect(validateAgentExecutionPlan(value)).toEqual([])
  })

  it("rejects Git-forbidden run, task, branch, and prefix refs", () => {
    const value = plan([{ id: "bad..task", objective: "bad", instruction: "x", dependsOn: [], scope: ["x"], specNodeIds: [] }])
    const mutated = {
      ...value,
      runId: "bad.lock",
      defaultBranch: "main@{old}",
      branchPrefix: ".hidden",
    }
    const codes = validateAgentExecutionPlan(mutated).map((item) => item.code)
    expect(codes).toEqual(expect.arrayContaining([
      "AGENT_EXECUTION_RUN_ID_INVALID",
      "AGENT_EXECUTION_TASK_ID_INVALID",
      "AGENT_EXECUTION_DEFAULT_BRANCH_INVALID",
      "AGENT_EXECUTION_BRANCH_PREFIX_INVALID",
      "AGENT_EXECUTION_FINGERPRINT_MISMATCH",
    ]))
  })
})
