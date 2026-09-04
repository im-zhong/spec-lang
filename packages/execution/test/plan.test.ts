import { describe, expect, it } from "vitest"
import {
  agentExecutionPlanFingerprint,
  agentExecutionSemanticInputDigest,
  createAgentExecutionPlan,
  validateAgentExecutionPlan,
} from "../src"

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
    expect(first.semanticInputDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(validateAgentExecutionPlan(first)).toEqual([])
    const otherShot = { ...second, runId: "run-2", repository: "owner/other", rootBaseSha: "d".repeat(40) }
    expect(otherShot.semanticInputDigest).toBe(first.semanticInputDigest)
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

  it("treats an omitted model override as a valid frozen CLI-default invocation", () => {
    const value = plan()
    delete value.environment.agent.model
    value.semanticInputDigest = agentExecutionSemanticInputDigest(value)
    value.fingerprint = agentExecutionPlanFingerprint(value)
    expect(validateAgentExecutionPlan(value)).toEqual([])
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

  it("validates the v0.2 single-writer loop and its clause table", () => {
    const value = plan([{
      id: "api",
      objective: "API",
      instruction: "build",
      dependsOn: [],
      scope: ["product/src/api.ts"],
      workingDirectory: "product",
      specNodeIds: [],
      loop: {
        schemaVersion: "spec-agent-task-loop/0.2" as const,
        maxRounds: 3,
        implementation: { instruction: "implement from the clause table", scope: ["product/src/api.ts"] },
        reviewer: {
          instruction: "review without edits",
          commands: ["python -m pytest tests/spec_oracle/test_api.py"],
          oracleFiles: ["product/tests/spec_oracle/test_api.py"],
          clauses: [
            { id: "route:POST /api", statement: "route exists", node: "api", kind: "route", verification: "oracle", level: "api" },
            { id: "review:api:no-extras", statement: "no extra APIs", node: "api", kind: "review", verification: "review", level: "api" },
          ],
        },
      },
    }])
    expect(validateAgentExecutionPlan(value)).toEqual([])

    const duplicateClause = structuredClone(value)
    duplicateClause.tasks[0].loop!.reviewer.clauses![1] = duplicateClause.tasks[0].loop!.reviewer.clauses![0]
    expect(validateAgentExecutionPlan(duplicateClause).map((item) => item.code)).toContain("AGENT_EXECUTION_LOOP_CLAUSE_INVALID")

    const foreignNode = structuredClone(value)
    foreignNode.tasks[0].loop!.reviewer.clauses![1].node = "other"
    expect(validateAgentExecutionPlan(foreignNode).map((item) => item.code)).toContain("AGENT_EXECUTION_LOOP_CLAUSE_INVALID")
  })
})
