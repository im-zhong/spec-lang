import type {
  AgentExecutionCheckResult,
  AgentExecutionPlan,
  AgentExecutionTaskResult,
  ResolvedAgentExecutionTask,
} from "@spec/core"

export interface IntegrationBase {
  sha: string
  ref: string
}

export interface CommitResult {
  headSha: string
  changedPaths: string[]
}

export interface PublishedAgentExecutionPlan {
  ref: string
  sha: string
}

export interface AgentExecutionRepositoryPort {
  /** Publish the canonical plan to an immutable remote Git ref. */
  publishPlan(plan: AgentExecutionPlan): Promise<PublishedAgentExecutionPlan>
  materializeIntegrationBase(
    plan: AgentExecutionPlan,
    taskId: string,
    dependencyResults: AgentExecutionTaskResult[],
  ): Promise<IntegrationBase>
  remoteHead(branch: string): Promise<string | undefined>
  verifyCommitProvenance(
    headSha: string,
    branch: string,
    expectedBaseSha: string,
    plan: AgentExecutionPlan,
    taskId: string,
  ): Promise<boolean>
  createWorkspace(task: ResolvedAgentExecutionTask, resumeHeadSha?: string): Promise<string>
  commitAndPush(
    task: ResolvedAgentExecutionTask,
    workspace: string,
    planFingerprint: string,
    options?: { allowEmpty?: boolean },
  ): Promise<CommitResult>
  removeWorkspace(workspace: string): Promise<void>
}

export interface ContainerExecutionResult {
  ok: boolean
  checks: AgentExecutionCheckResult[]
  costUsd?: number
  error?: string
}

export interface AgentExecutionContainerPort {
  execute(task: ResolvedAgentExecutionTask, workspace: string): Promise<ContainerExecutionResult>
}

export interface PullRequestRecord {
  number: number
  url: string
  state: "open" | "closed" | "merged"
}

export interface AgentExecutionGitHubPort {
  findPullRequest(repository: string, branch: string): Promise<PullRequestRecord | undefined>
  upsertPullRequest(input: {
    repository: string
    head: string
    base: string
    title: string
    body: string
  }): Promise<PullRequestRecord>
  waitForChecks(input: {
    repository: string
    pullRequest: number
    requiredChecks: string[]
    expectedHeadSha: string
  }): Promise<AgentExecutionCheckResult[]>
  enqueuePullRequest(repository: string, pullRequest: number): Promise<void>
}
