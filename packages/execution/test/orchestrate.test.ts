import { describe, expect, it } from "vitest"
import type {
  AgentExecutionPlan,
  AgentExecutionTaskResult,
  ResolvedAgentExecutionTask,
} from "@spec/core"
import {
  createAgentExecutionPlan,
  runAgentExecutionPlan,
  type CommitResult,
  type ContainerExecutionResult,
  type AgentExecutionContainerPort,
  type AgentExecutionControlPlanePort,
  type AgentExecutionRepositoryPort,
  type MergeResult,
  type IntegrationBase,
  type PullRequestRecord,
} from "../src"

const SHA = "a".repeat(40)
const HASH = "b".repeat(64)

function fixturePlan(mergePolicy: AgentExecutionPlan["mergePolicy"] = "pull-request"): AgentExecutionPlan {
  return createAgentExecutionPlan({
    runId: "dogfood",
    mergePolicy,
    repository: "owner/repo",
    rootBaseSha: SHA,
    environment: {
      image: `registry.example.com/dev@sha256:${"c".repeat(64)}`,
      devcontainerHash: HASH,
      toolchainLockHash: HASH,
      agent: { model: "test-model", effort: "high", maxTurns: 20, maxConcurrency: 2 },
    },
    acceptance: { requiredChecks: ["clean-container"], commands: ["test -f output"] },
    tasks: [
      { id: "left", objective: "left", instruction: "left", dependsOn: [], scope: ["left"], specNodeIds: [] },
      { id: "right", objective: "right", instruction: "right", dependsOn: [], scope: ["right"], specNodeIds: [] },
      { id: "child", objective: "child", instruction: "child", dependsOn: ["left", "right"], scope: ["output"], specNodeIds: [] },
    ],
  })
}

class FakeRepository implements AgentExecutionRepositoryPort {
  readonly heads = new Map<string, string>()
  readonly provenance = new Map<string, { run: string; task: string; fingerprint: string }>()
  readonly commitCounts = new Map<string, number>()

  async publishPlan(plan: AgentExecutionPlan) { return { ref: `${plan.branchPrefix}/${plan.runId}/plan`, sha: "f".repeat(40) } }

  async materializeIntegrationBase(plan: AgentExecutionPlan, taskId: string, dependencies: AgentExecutionTaskResult[]): Promise<IntegrationBase> {
    for (const dependency of dependencies) expect(this.heads.get(dependency.branch!)).toBe(dependency.headSha)
    return { sha: dependencies.length === 0 ? plan.rootBaseSha : (taskId.charCodeAt(0).toString(16).padStart(40, "d").slice(0, 40)), ref: `${plan.branchPrefix}/${plan.runId}/bases/${taskId}` }
  }
  async remoteHead(branch: string) { return this.heads.get(branch) }
  async verifyCommitProvenance(head: string, _branch: string, _base: string, plan: AgentExecutionPlan, taskId: string) {
    const value = this.provenance.get(head)
    return value?.run === plan.runId && value.task === taskId && value.fingerprint === plan.fingerprint
  }
  async createWorkspace(task: ResolvedAgentExecutionTask) { return `/tmp/${task.runId}/${task.id}` }
  async commitAndPush(task: ResolvedAgentExecutionTask, _workspace: string, fingerprint: string): Promise<CommitResult> {
    const count = (this.commitCounts.get(task.id) ?? 0) + 1
    this.commitCounts.set(task.id, count)
    const prefix = task.id.padEnd(38, "e").slice(0, 38).replace(/[^a-f0-9]/g, "e")
    const headSha = `${prefix}${count.toString(16).padStart(2, "0")}`
    this.heads.set(task.branch, headSha)
    this.provenance.set(headSha, { run: task.runId, task: task.id, fingerprint })
    return { headSha, changedPaths: [...task.scope] }
  }
  readonly merges: Array<{ taskId: string; headSha: string }> = []
  mergeLock = Promise.resolve()

  async mergeIntoDefaultBranch(plan: AgentExecutionPlan, taskId: string, headSha: string): Promise<MergeResult> {
    // Mirror the orchestrator's serialization: at most one merge in flight.
    const record = { taskId, headSha }
    const run = this.mergeLock.then(async () => {
      this.merges.push(record)
      const sha = `m${(this.merges.length).toString(16).padStart(39, "0")}`
      return { sha, alreadyMerged: false }
    })
    this.mergeLock = run.then(() => undefined, () => undefined)
    return run
  }

  async removeWorkspace() {}
}

class FakeContainers implements AgentExecutionContainerPort {
  calls = 0
  active = new Set<string>()
  observedParallel = false
  async execute(task: ResolvedAgentExecutionTask): Promise<ContainerExecutionResult> {
    this.calls++
    this.active.add(task.id)
    if (this.active.has("left") && this.active.has("right")) this.observedParallel = true
    await new Promise((resolve) => setTimeout(resolve, 10))
    this.active.delete(task.id)
    return { ok: true, checks: [{ name: "generation/agent", status: "success" }] }
  }
}

class FakeControlPlane implements AgentExecutionControlPlanePort {
  readonly pullRequests = new Map<string, PullRequestRecord & { base: string }>()
  failFirstHead = false
  private failedHead?: string
  async findPullRequest(_repository: string, branch: string) { return this.pullRequests.get(branch) }
  async upsertPullRequest(input: { repository: string; head: string; base: string; title: string; body: string }) {
    const record = { number: this.pullRequests.size + 1, url: `https://example.test/${this.pullRequests.size + 1}`, state: "open" as const, base: input.base }
    this.pullRequests.set(input.head, record)
    return record
  }
  readonly checkedAcceptance: Array<{ headSha: string; commands: string[]; workingDirectory?: string }> = []

  async waitForChecks(input: { repository: string; pullRequest: number; requiredChecks: string[]; expectedHeadSha: string; acceptance: { commands: string[]; workingDirectory?: string } }) {
    this.checkedAcceptance.push({ headSha: input.expectedHeadSha, commands: input.acceptance.commands, ...(input.acceptance.workingDirectory ? { workingDirectory: input.acceptance.workingDirectory } : {}) })
    if (this.failFirstHead && (!this.failedHead || this.failedHead === input.expectedHeadSha)) {
      this.failedHead = input.expectedHeadSha
      return input.requiredChecks.map((name) => ({ name, status: "failure" as const }))
    }
    return input.requiredChecks.map((name) => ({ name, status: "success" as const }))
  }
  async enqueuePullRequest() {}
}

describe("agent DAG execution orchestration", () => {
  it("publishes parallel task branches/PRs, gates the child, and resumes from durable state", async () => {
    const repository = new FakeRepository()
    const containers = new FakeContainers()
    const github = new FakeControlPlane()
    const plan = fixturePlan()
    const first = await runAgentExecutionPlan(plan, { repository, containers, controlPlane: github, concurrency: 2 })
    expect(first.ok).toBe(true)
    expect(containers.observedParallel).toBe(true)
    expect(containers.calls).toBe(3)
    expect(first.tasks.every((task) => task.headSha && task.pullRequest)).toBe(true)
    expect(github.pullRequests.get("spec/generate/dogfood/child")?.base).toBe("main")
    expect(github.pullRequests.get("spec/generate/dogfood/left")?.base).toBe("spec/generate/dogfood/bases/left")

    github.pullRequests.delete("spec/generate/dogfood/left")
    const resumed = await runAgentExecutionPlan(plan, { repository, containers, controlPlane: github, concurrency: 2, resume: true })
    expect(resumed.ok).toBe(true)
    expect(containers.calls).toBe(3)
    expect(resumed.tasks.map((task) => task.headSha)).toEqual(first.tasks.map((task) => task.headSha))
  })

  it("resume appends a retry checkpoint after a durable head fails CI", async () => {
    const repository = new FakeRepository()
    const containers = new FakeContainers()
    const github = new FakeControlPlane()
    github.failFirstHead = true
    const full = fixturePlan()
    const plan = createAgentExecutionPlan({
      runId: "retry",
      repository: full.repository,
      rootBaseSha: full.rootBaseSha,
      environment: full.environment,
      acceptance: full.acceptance,
      tasks: [{ id: "only", objective: "only", instruction: "only", dependsOn: [], scope: ["only"], specNodeIds: [] }],
    })
    const failed = await runAgentExecutionPlan(plan, { repository, containers, controlPlane: github })
    expect(failed.ok).toBe(false)
    const failedHead = failed.tasks[0].headSha
    expect(failedHead).toBeTruthy()

    const resumed = await runAgentExecutionPlan(plan, { repository, containers, controlPlane: github, resume: true })
    expect(resumed.ok).toBe(true)
    expect(resumed.tasks[0].headSha).not.toBe(failedHead)
    expect(containers.calls).toBe(2)
  })

  it("merge-to-main lands every internally checked node on the default branch by code", async () => {
    const repository = new FakeRepository()
    const containers = new FakeContainers()
    const github = new FakeControlPlane()
    const plan = fixturePlan("merge-to-main")
    const report = await runAgentExecutionPlan(plan, { repository, containers, controlPlane: github, concurrency: 2 })
    expect(report.ok).toBe(true)
    expect(report.tasks.every((task) => task.status === "merged")).toBe(true)
    expect(report.tasks.every((task) => task.mergedSha)).toBe(true)
    // Dependencies merge before their dependents: the child lands last.
    const order = repository.merges.map((merge) => merge.taskId)
    expect(order.indexOf("child")).toBeGreaterThan(order.indexOf("left"))
    expect(order.indexOf("child")).toBeGreaterThan(order.indexOf("right"))
    // Every merge reuses the same durable head the checks verified.
    for (const merge of repository.merges) {
      expect(report.tasks.find((task) => task.taskId === merge.taskId)?.headSha).toBe(merge.headSha)
    }
  })

  it("merge-to-main skips the merge and fails loud when a node's own checks fail", async () => {
    const repository = new FakeRepository()
    const containers = new FakeContainers()
    const github = new FakeControlPlane()
    github.failFirstHead = true
    const plan = createAgentExecutionPlan({
      runId: "failing",
      mergePolicy: "merge-to-main",
      repository: "owner/repo",
      rootBaseSha: SHA,
      environment: {
        image: `registry.example.com/dev@sha256:${"c".repeat(64)}`,
        devcontainerHash: HASH,
        toolchainLockHash: HASH,
        agent: { model: "test-model", effort: "high", maxTurns: 20, maxConcurrency: 2 },
      },
      acceptance: { requiredChecks: ["clean-container"], commands: ["test -f output"] },
      tasks: [{ id: "only", objective: "only", instruction: "only", dependsOn: [], scope: ["only"], specNodeIds: [] }],
    })
    const report = await runAgentExecutionPlan(plan, { repository, containers, controlPlane: github })
    expect(report.ok).toBe(false)
    expect(repository.merges).toHaveLength(0)
    expect(report.tasks[0].status).toBe("failure")
  })

  it("merge-to-main resume re-derives durable state idempotently for already-checked heads", async () => {
    const repository = new FakeRepository()
    const containers = new FakeContainers()
    const github = new FakeControlPlane()
    const plan = fixturePlan("merge-to-main")
    const first = await runAgentExecutionPlan(plan, { repository, containers, controlPlane: github, concurrency: 2 })
    expect(first.ok).toBe(true)

    // Simulate a checkpoint resume: durable heads survive, no new work.
    const mergesBefore = repository.merges.length
    const resumed = await runAgentExecutionPlan(plan, { repository, containers, controlPlane: github, concurrency: 2, resume: false })
    expect(resumed.ok).toBe(true)
    expect(containers.calls).toBe(3)
    expect(repository.merges.length).toBe(mergesBefore * 2)
  })

  it("forwards each task's frozen acceptance to the control plane for branch verification", async () => {
    const repository = new FakeRepository()
    const containers = new FakeContainers()
    const github = new FakeControlPlane()
    const plan = fixturePlan()
    const report = await runAgentExecutionPlan(plan, { repository, containers, controlPlane: github, concurrency: 2 })
    expect(report.ok).toBe(true)
    expect(github.checkedAcceptance.length).toBeGreaterThan(0)
    expect(github.checkedAcceptance.every((item) => item.commands)).toBe(true)
  })
})
