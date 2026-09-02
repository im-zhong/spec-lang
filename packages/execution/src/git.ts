import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { AgentExecutionPlan, AgentExecutionTaskResult, ResolvedAgentExecutionTask } from "@spec/core"
import { agentExecutionPlanRef, taskBaseRef } from "./plan"
import { commandFailure, runProcess, type ProcessResult } from "./process"
import type { CommitResult, AgentExecutionRepositoryPort, IntegrationBase, PublishedAgentExecutionPlan } from "./ports"

const FULL_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (typeof input === "object" && input !== null) {
      return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]))
    }
    return input
  }
  return JSON.stringify(normalize(value), null, 2) + "\n"
}

export interface GitAgentExecutionRepositoryOptions {
  repoRoot: string
  worktreeRoot: string
  remote?: string
}

export class GitAgentExecutionRepository implements AgentExecutionRepositoryPort {
  private readonly repoRoot: string
  private readonly worktreeRoot: string
  private readonly remote: string

  constructor(options: GitAgentExecutionRepositoryOptions) {
    this.repoRoot = path.resolve(options.repoRoot)
    this.worktreeRoot = path.resolve(options.worktreeRoot)
    this.remote = options.remote ?? "origin"
  }

  private async git(args: string[], cwd = this.repoRoot, env?: NodeJS.ProcessEnv): Promise<ProcessResult> {
    const result = await runProcess("git", args, { cwd, env: { ...process.env, ...env }, timeoutMs: 180_000 })
    if (!result.ok) throw commandFailure(result)
    if (result.stdoutTruncated || result.stderrTruncated) throw new Error(`git ${args[0]} output exceeded the bounded execution log`)
    return result
  }

  /**
   * Fetch one remote branch without touching the repository-wide FETCH_HEAD.
   *
   * The explicit refspec makes Git update a branch-specific scratch ref under
   * its normal ref lock, so concurrent task fetches cannot overwrite one
   * another's identity before provenance verification reads it.
   */
  private async fetchRemoteBranch(branch: string): Promise<string> {
    const key = createHash("sha256").update(`${this.remote}\0${branch}`).digest("hex")
    const fetchedRef = `refs/spec-fetch/${key}`
    await this.git([
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      this.remote,
      `+refs/heads/${branch}:${fetchedRef}`,
    ])
    const sha = (await this.git(["rev-parse", "--verify", `${fetchedRef}^{commit}`])).stdout.trim()
    if (!FULL_SHA.test(sha)) throw new Error(`git fetch returned an invalid commit SHA for remote branch "${branch}"`)
    return sha
  }

  async remoteHead(branch: string): Promise<string | undefined> {
    const result = await runProcess("git", ["ls-remote", "--heads", this.remote, `refs/heads/${branch}`], {
      cwd: this.repoRoot,
      timeoutMs: 120_000,
    })
    if (!result.ok) throw commandFailure(result)
    const sha = result.stdout.trim().split(/\s+/)[0]
    return FULL_SHA.test(sha ?? "") ? sha : undefined
  }

  private async publishImmutableRef(ref: string, sha: string): Promise<void> {
    const remote = await this.remoteHead(ref)
    if (remote === sha) return
    if (remote !== undefined) throw new Error(`remote integration ref "${ref}" already points at ${remote}, expected ${sha}`)
    await this.git(["push", this.remote, `${sha}:refs/heads/${ref}`])
  }

  async publishPlan(plan: AgentExecutionPlan): Promise<PublishedAgentExecutionPlan> {
    const ref = agentExecutionPlanRef(plan)
    const canonical = canonicalJson(plan)
    const existing = await this.remoteHead(ref)
    if (existing) {
      const fetched = await this.fetchRemoteBranch(ref)
      if (fetched !== existing) throw new Error(`remote plan ref "${ref}" moved from ${existing} to ${fetched} while fetching`)
      const stored = await this.git(["show", `${existing}:plan.json`])
      if (stored.stdout !== canonical) {
        throw new Error(`remote plan ref "${ref}" already contains a different immutable plan`)
      }
      return { ref, sha: existing }
    }

    await this.git(["cat-file", "-e", `${plan.rootBaseSha}^{commit}`])
    const blob = await runProcess("git", ["hash-object", "-w", "--stdin"], {
      cwd: this.repoRoot,
      input: canonical,
      timeoutMs: 120_000,
    })
    if (!blob.ok) throw commandFailure(blob)
    const blobSha = blob.stdout.trim()
    if (!FULL_SHA.test(blobSha)) throw new Error("git hash-object returned an invalid plan blob SHA")
    const tree = await runProcess("git", ["mktree"], {
      cwd: this.repoRoot,
      input: `100644 blob ${blobSha}\tplan.json\n`,
      timeoutMs: 120_000,
    })
    if (!tree.ok) throw commandFailure(tree)
    const treeSha = tree.stdout.trim()
    if (!FULL_SHA.test(treeSha)) throw new Error("git mktree returned an invalid plan tree SHA")
    const commit = await this.git(
      ["commit-tree", treeSha, "-p", plan.rootBaseSha, "-m", `spec agent execution plan: ${plan.runId}\n\nSpec-Fingerprint: ${plan.fingerprint}\n`],
      this.repoRoot,
      {
        GIT_AUTHOR_NAME: "spec agent execution",
        GIT_AUTHOR_EMAIL: "spec-agent-execution@invalid.local",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_NAME: "spec agent execution",
        GIT_COMMITTER_EMAIL: "spec-agent-execution@invalid.local",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    )
    const sha = commit.stdout.trim()
    if (!FULL_SHA.test(sha)) throw new Error("git commit-tree returned an invalid plan commit SHA")
    await this.publishImmutableRef(ref, sha)
    return { ref, sha }
  }

  async materializeIntegrationBase(
    plan: AgentExecutionPlan,
    taskId: string,
    dependencyResults: AgentExecutionTaskResult[],
  ): Promise<IntegrationBase> {
    const parents = [...dependencyResults].sort((left, right) => left.taskId.localeCompare(right.taskId))
    for (const parent of parents) {
      if (!parent.headSha || !parent.branch) throw new Error(`dependency "${parent.taskId}" has no published branch/head SHA`)
      const remote = await this.remoteHead(parent.branch)
      if (remote !== parent.headSha) throw new Error(`dependency "${parent.taskId}" head ${parent.headSha} is not published at ${parent.branch}`)
      const fetched = await this.fetchRemoteBranch(parent.branch)
      if (fetched !== parent.headSha) throw new Error(`dependency "${parent.taskId}" moved from ${parent.headSha} to ${fetched} while fetching`)
    }

    let current = parents.length === 0 ? plan.rootBaseSha : parents[0].headSha!
    await this.git(["cat-file", "-e", `${current}^{commit}`])
    for (const parent of parents.slice(1)) {
      const merged = await runProcess("git", ["merge-tree", "--write-tree", current, parent.headSha!], {
        cwd: this.repoRoot,
        timeoutMs: 120_000,
      })
      if (!merged.ok) {
        throw new Error(`integration base conflict for task "${taskId}" while merging "${parent.taskId}": ${(merged.stdout + merged.stderr).slice(-4000)}`)
      }
      const tree = merged.stdout.trim().split(/\s+/)[0]
      if (!FULL_SHA.test(tree ?? "")) throw new Error(`git merge-tree returned no tree for task "${taskId}"`)
      const message = `spec agent execution integration: ${plan.runId}/${taskId}\n\nMerged-Task: ${parent.taskId}\n`
      const withMessage = await this.git(
        ["commit-tree", tree, "-p", current, "-p", parent.headSha!, "-m", message],
        this.repoRoot,
        {
          GIT_AUTHOR_NAME: "spec agent execution",
          GIT_AUTHOR_EMAIL: "spec-agent-execution@invalid.local",
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_NAME: "spec agent execution",
          GIT_COMMITTER_EMAIL: "spec-agent-execution@invalid.local",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        },
      )
      current = withMessage.stdout.trim()
      if (!FULL_SHA.test(current)) throw new Error(`git commit-tree returned an invalid integration SHA for task "${taskId}"`)
    }
    const ref = taskBaseRef(plan, taskId)
    await this.publishImmutableRef(ref, current)
    return { sha: current, ref }
  }

  async verifyCommitProvenance(
    headSha: string,
    branch: string,
    expectedBaseSha: string,
    plan: AgentExecutionPlan,
    taskId: string,
  ): Promise<boolean> {
    const fetchedHead = await this.fetchRemoteBranch(branch)
    if (fetchedHead !== headSha) return false
    const ancestor = await runProcess("git", ["merge-base", "--is-ancestor", expectedBaseSha, headSha], { cwd: this.repoRoot })
    if (!ancestor.ok) return false
    const result = await runProcess("git", ["show", "-s", "--format=%B", headSha], { cwd: this.repoRoot })
    if (!result.ok) return false
    const trailers = new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()))
    if (!trailers.has(`Spec-Run: ${plan.runId}`) ||
        !trailers.has(`Spec-Task: ${taskId}`) ||
        !trailers.has(`Spec-Fingerprint: ${plan.fingerprint}`)) return false
    const task = plan.tasks.find((candidate) => candidate.id === taskId)
    if (!task) return false
    const changed = await runProcess("git", ["diff", "--name-only", "-z", expectedBaseSha, headSha], { cwd: this.repoRoot })
    if (!changed.ok || changed.stdoutTruncated) return false
    return changed.stdout.split("\0").filter(Boolean).every((file) => task.scope.includes(file))
  }

  async createWorkspace(task: ResolvedAgentExecutionTask, resumeHeadSha?: string): Promise<string> {
    fs.mkdirSync(this.worktreeRoot, { recursive: true })
    const workspace = path.join(this.worktreeRoot, task.runId, task.id)
    if (fs.existsSync(workspace)) await this.removeWorkspace(workspace)
    fs.mkdirSync(path.dirname(workspace), { recursive: true })
    const start = resumeHeadSha ?? task.baseSha
    if (resumeHeadSha) {
      const fetched = await this.fetchRemoteBranch(task.branch)
      if (fetched !== resumeHeadSha) throw new Error(`remote task branch "${task.branch}" moved from ${resumeHeadSha} to ${fetched} while fetching`)
    }
    await this.git(["worktree", "add", "--detach", workspace, start])
    return workspace
  }

  private async changedPaths(workspace: string): Promise<string[]> {
    const tracked = await this.git(["diff", "--name-only", "-z", "HEAD"], workspace)
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard", "-z"], workspace)
    return [...new Set(`${tracked.stdout}${untracked.stdout}`.split("\0").filter(Boolean))].sort()
  }

  async commitAndPush(
    task: ResolvedAgentExecutionTask,
    workspace: string,
    planFingerprint: string,
    options: { allowEmpty?: boolean } = {},
  ): Promise<CommitResult> {
    const changedPaths = await this.changedPaths(workspace)
    if (changedPaths.length === 0 && !options.allowEmpty) throw new Error(`task "${task.id}" produced no repository changes`)
    const violations = changedPaths.filter((file) => !task.scope.includes(file))
    if (violations.length > 0) throw new Error(`task "${task.id}" modified files outside its exact scope: ${violations.join(", ")}`)
    if (task.scope.length > 0) await this.git(["add", "--all", "--", ...task.scope], workspace)
    const whitespace = await runProcess("git", ["diff", "--cached", "--check"], { cwd: workspace, timeoutMs: 120_000 })
    if (!whitespace.ok) throw commandFailure(whitespace)
    const dependencyTrailers = Object.entries(task.dependencyHeadShas)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, sha]) => `Depends-On-Sha: ${id}=${sha}`)
      .join("\n")
    const message = [
      `spec(${task.id}): ${task.objective}`,
      "",
      `Spec-Run: ${task.runId}`,
      `Spec-Task: ${task.id}`,
      `Spec-Fingerprint: ${planFingerprint}`,
      dependencyTrailers,
    ].filter((line, index, values) => line !== "" || values[index - 1] !== "").join("\n")
    await this.git(
      ["-c", "user.name=spec agent execution", "-c", "user.email=spec-agent-execution@invalid.local", "commit", ...(options.allowEmpty ? ["--allow-empty"] : []), "-m", message],
      workspace,
      {
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    )
    const headSha = (await this.git(["rev-parse", "HEAD"], workspace)).stdout.trim()
    const remote = await this.remoteHead(task.branch)
    if (remote && remote !== headSha) {
      const ancestor = await runProcess("git", ["merge-base", "--is-ancestor", remote, headSha], { cwd: workspace })
      if (!ancestor.ok) throw new Error(`remote task branch "${task.branch}" diverged at ${remote}; refusing to overwrite it`)
    }
    if (remote !== headSha) await this.git(["push", this.remote, `HEAD:refs/heads/${task.branch}`], workspace)
    return { headSha, changedPaths }
  }

  async removeWorkspace(workspace: string): Promise<void> {
    const target = path.resolve(workspace)
    const root = this.worktreeRoot.endsWith(path.sep) ? this.worktreeRoot : `${this.worktreeRoot}${path.sep}`
    if (!target.startsWith(root)) throw new Error(`refusing to remove worktree outside ${this.worktreeRoot}: ${target}`)
    if (!fs.existsSync(target)) return
    const result = await runProcess("git", ["worktree", "remove", "--force", target], {
      cwd: this.repoRoot,
      timeoutMs: 120_000,
    })
    if (!result.ok) throw commandFailure(result)
  }
}
