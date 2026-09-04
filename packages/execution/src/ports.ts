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

export interface MergeResult {
  /** Default-branch head after the merge (or the head that already contained it). */
  sha: string
  alreadyMerged: boolean
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
  /**
   * Deterministically merge a fully checked task head into the plan's default
   * branch: merge-tree + commit-tree + push, no working tree, no human. The
   * compiler's scope partition guarantees a conflict-free merge; a conflict is
   * a contract defect and must fail loud. Idempotent for an already-merged
   * head so resume can re-derive durable state.
   */
  mergeIntoDefaultBranch(plan: AgentExecutionPlan, taskId: string, headSha: string): Promise<MergeResult>
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

/** Frozen acceptance a control plane may replay against a pushed task head. */
export interface BranchAcceptance {
  commands: string[]
  workingDirectory?: string
}

export interface WaitForChecksInput {
  repository: string
  pullRequest: number
  requiredChecks: string[]
  expectedHeadSha: string
  /**
   * The task's frozen acceptance. The GitHub control plane ignores it —
   * Actions resolves the same commands from the immutable plan ref. Local
   * control planes execute it in a fresh checkout of the pushed head, which
   * is what makes their check verdicts as strong as a CI run.
   */
  acceptance: BranchAcceptance
}

export interface UpsertPullRequestInput {
  repository: string
  head: string
  base: string
  title: string
  body: string
}

/**
 * The durable-branch control plane: pull-request records, required checks,
 * and policy-driven landing. Implementations exist for GitHub (real PRs and
 * Actions checks) and for a plain local Git remote (synthetic PR records and
 * worktree-replayed checks).
 */
export interface AgentExecutionControlPlanePort {
  findPullRequest(repository: string, branch: string): Promise<PullRequestRecord | undefined>
  upsertPullRequest(input: UpsertPullRequestInput): Promise<PullRequestRecord>
  waitForChecks(input: WaitForChecksInput): Promise<AgentExecutionCheckResult[]>
  enqueuePullRequest(repository: string, pullRequest: number): Promise<void>
}

/** @deprecated Renamed to AgentExecutionControlPlanePort when local Git joined GitHub as a control plane. */
export type AgentExecutionGitHubPort = AgentExecutionControlPlanePort
