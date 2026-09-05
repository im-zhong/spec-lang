import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { AgentExecutionPlan, AgentExecutionTaskResult, ResolvedAgentExecutionTask } from "@spec/core"
import { agentExecutionPlanRef, taskBaseRef } from "./plan"
import { commandFailure, runProcess, type ProcessResult } from "./process"
import type { CommitResult, AgentExecutionRepositoryPort, IntegrationBase, MergeResult, PublishedAgentExecutionPlan } from "./ports"

const FULL_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const REMOTE_READ_ATTEMPTS = 3

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
  /** Test seam; production uses `git`. */
  gitCli?: string
}

export class GitAgentExecutionRepository implements AgentExecutionRepositoryPort {
  private readonly repoRoot: string
  private readonly worktreeRoot: string
  private readonly remote: string
  private readonly gitCli: string

  constructor(options: GitAgentExecutionRepositoryOptions) {
    this.repoRoot = path.resolve(options.repoRoot)
    this.worktreeRoot = path.resolve(options.worktreeRoot)
    this.remote = options.remote ?? "origin"
    this.gitCli = options.gitCli ?? "git"
  }

  private async git(args: string[], cwd = this.repoRoot, env?: NodeJS.ProcessEnv, maxOutputBytes?: number): Promise<ProcessResult> {
    const result = await runProcess(this.gitCli, args, { cwd, env: { ...process.env, ...env }, timeoutMs: 180_000, ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}) })
    if (!result.ok) throw commandFailure(result)
    if (result.stdoutTruncated || result.stderrTruncated) throw new Error(`git ${args[0]} output exceeded the bounded execution log`)
    return result
  }

  /** Retry only remote reads; agent execution and conformance remain single-shot. */
  private async remoteRead(args: string[]): Promise<ProcessResult> {
    let last: ProcessResult | undefined
    for (let attempt = 1; attempt <= REMOTE_READ_ATTEMPTS; attempt++) {
      const result = await runProcess(this.gitCli, args, { cwd: this.repoRoot, timeoutMs: 180_000 })
      if (result.ok) {
        if (result.stdoutTruncated || result.stderrTruncated) {
          throw new Error(`git ${args[0]} output exceeded the bounded execution log`)
        }
        return result
      }
      last = result
      if (attempt < REMOTE_READ_ATTEMPTS) await delay(250 * attempt)
    }
    throw commandFailure(last!)
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
    await this.remoteRead([
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
    const result = await this.remoteRead(["ls-remote", "--heads", this.remote, `refs/heads/${branch}`])
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
      // The plan embeds every seed file's bytes (oracle, conformance,
      // registry), so it legitimately exceeds the generic 1 MiB process
      // bound; the immutability comparison needs the full document.
      const stored = await this.git(["show", `${existing}:plan.json`], undefined, undefined, 64 * 1024 * 1024)
      if (stored.stdout !== canonical) {
        throw new Error(`remote plan ref "${ref}" already contains a different immutable plan`)
      }
      return { ref, sha: existing }
    }

    await this.git(["cat-file", "-e", `${plan.rootBaseSha}^{commit}`])
    const blob = await runProcess(this.gitCli, ["hash-object", "-w", "--stdin"], {
      cwd: this.repoRoot,
      input: canonical,
      timeoutMs: 120_000,
    })
    if (!blob.ok) throw commandFailure(blob)
    const blobSha = blob.stdout.trim()
    if (!FULL_SHA.test(blobSha)) throw new Error("git hash-object returned an invalid plan blob SHA")
    const tree = await runProcess(this.gitCli, ["mktree"], {
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
    if (plan.mergePolicy === "merge-to-main") {
      // The team model, made deterministic: main is the single integration
      // line, and a node's integration base is the main commit at which its
      // dependency closure completed — NOT the main head at start time. All
      // siblings of a dependency therefore branch from the exact same commit
      // no matter when the scheduler releases them, so workspace content is
      // independent of scheduling. Every checked head lands through exactly
      // one two-parent integration commit whose second parent is that task
      // head, so the landing commit is mechanically locatable on main's
      // first-parent chain.
      const mainSha = await this.fetchRemoteBranch(plan.defaultBranch)
      if (dependencyResults.length === 0) {
        const rooted = await runProcess(this.gitCli, ["merge-base", "--is-ancestor", plan.rootBaseSha, mainSha], { cwd: this.repoRoot })
        if (!rooted.ok) throw new Error(`default branch ${plan.defaultBranch} (${mainSha}) does not contain the run's root base ${plan.rootBaseSha}`)
        return { sha: plan.rootBaseSha, ref: plan.defaultBranch }
      }
      const chain = await this.git(["log", "--first-parent", "--format=%H %P", mainSha])
      const lines = chain.stdout.trim() ? chain.stdout.trim().split("\n") : []
      // lines[0] is the newest integration; index grows toward the root.
      const landingIndex = new Map<string, number>()
      for (let index = 0; index < lines.length; index++) {
        const [commit, ...parents] = lines[index]!.split(/\s+/)
        for (const dependency of dependencyResults) {
          if (dependency.headSha && parents.includes(dependency.headSha)) landingIndex.set(dependency.taskId, index)
        }
      }
      let newest: number | undefined
      for (const dependency of dependencyResults) {
        if (!dependency.headSha) throw new Error(`dependency "${dependency.taskId}" has no published head SHA`)
        const index = landingIndex.get(dependency.taskId)
        if (index === undefined) {
          throw new Error(
            `dependency "${dependency.taskId}" head ${dependency.headSha} has not landed on ${plan.defaultBranch} (${mainSha}); ` +
            `task "${taskId}" may only start from a main that contains all of its dependencies`,
          )
        }
        // lines[0] is the newest commit, so the last dependency to land has
        // the smallest index; that commit's ancestry contains the whole closure.
        newest = newest === undefined ? index : Math.min(newest, index)
      }
      const base = lines[newest!]!.split(/\s+/)[0]!
      if (!FULL_SHA.test(base)) throw new Error(`could not resolve a landed integration base for task "${taskId}"`)
      for (const dependency of dependencyResults) {
        const contained = await runProcess(this.gitCli, ["merge-base", "--is-ancestor", dependency.headSha!, base], { cwd: this.repoRoot })
        if (!contained.ok) throw new Error(`integration base ${base} for task "${taskId}" does not contain dependency "${dependency.taskId}"`)
      }
      return { sha: base, ref: plan.defaultBranch }
    }

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
      const merged = await runProcess(this.gitCli, ["merge-tree", "--write-tree", current, parent.headSha!], {
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

  /**
   * The team-model integration step, executed by code: merge one fully
   * checked feature-node head into the default branch with a deterministic
   * two-parent commit, then publish it. Callers serialize per process; the
   * bounded retry covers a remote default branch that moved concurrently
   * (an interleaved resume or a push from outside this process).
   */
  async mergeIntoDefaultBranch(plan: AgentExecutionPlan, taskId: string, headSha: string): Promise<MergeResult> {
    if (!FULL_SHA.test(headSha)) throw new Error(`merge-to-main received an invalid commit SHA for task "${taskId}": ${headSha}`)
    await this.git(["cat-file", "-e", `${headSha}^{commit}`])
    for (let attempt = 1; ; attempt++) {
      const mainSha = await this.fetchRemoteBranch(plan.defaultBranch)
      const alreadyMerged = await runProcess(this.gitCli, ["merge-base", "--is-ancestor", headSha, mainSha], { cwd: this.repoRoot })
      if (alreadyMerged.ok) return { sha: mainSha, alreadyMerged: true }
      const merged = await runProcess(this.gitCli, ["merge-tree", "--write-tree", mainSha, headSha], {
        cwd: this.repoRoot,
        timeoutMs: 120_000,
      })
      if (!merged.ok) {
        throw new Error(
          `merge-to-main conflict for task "${taskId}" merging ${headSha} into ${plan.defaultBranch}@${mainSha}: ` +
          `the compiler scope partition should make this impossible — fix the contract, do not resolve by hand. ` +
          `${(merged.stdout + merged.stderr).slice(-4000)}`,
        )
      }
      const tree = merged.stdout.trim().split(/\s+/)[0]
      if (!FULL_SHA.test(tree ?? "")) throw new Error(`git merge-tree returned no tree for task "${taskId}"`)
      const message = `spec integrate: ${plan.runId}/${taskId}\n\n` +
        `Spec-Run: ${plan.runId}\nSpec-Task: ${taskId}\nSpec-Fingerprint: ${plan.fingerprint}\n` +
        `Merged-Into: ${plan.defaultBranch}\n`
      const commit = await this.git(
        ["commit-tree", tree, "-p", mainSha, "-p", headSha, "-m", message],
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
      const integration = commit.stdout.trim()
      if (!FULL_SHA.test(integration)) throw new Error(`git commit-tree returned an invalid integration SHA for task "${taskId}"`)
      const pushed = await runProcess(this.gitCli, ["push", this.remote, `${integration}:refs/heads/${plan.defaultBranch}`], {
        cwd: this.repoRoot,
        timeoutMs: 180_000,
      })
      if (pushed.ok) return { sha: integration, alreadyMerged: false }
      if (attempt >= 3) throw commandFailure(pushed)
      // The remote default branch moved under us; re-derive from a fresh fetch.
    }
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
    const ancestor = await runProcess(this.gitCli, ["merge-base", "--is-ancestor", expectedBaseSha, headSha], { cwd: this.repoRoot })
    if (!ancestor.ok) return false
    const result = await runProcess(this.gitCli, ["show", "-s", "--format=%B", headSha], { cwd: this.repoRoot })
    if (!result.ok) return false
    const trailers = new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()))
    if (!trailers.has(`Spec-Run: ${plan.runId}`) ||
        !trailers.has(`Spec-Task: ${taskId}`) ||
        !trailers.has(`Spec-Fingerprint: ${plan.fingerprint}`)) return false
    const task = plan.tasks.find((candidate) => candidate.id === taskId)
    if (!task) return false
    const changed = await runProcess(this.gitCli, ["diff", "--name-only", "-z", expectedBaseSha, headSha], { cwd: this.repoRoot })
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
    if (changedPaths.length === 0 && !options.allowEmpty) {
      // A materialize task with no diff is IDEMPOTENT SUCCESS — the
      // files are already correct on the base (e.g. retry after a
      // compiler fix that didn't change THIS task's seed bytes).
      if (task.executor === "materialize") return { headSha: base, checks: [] }
      throw new Error(`task "${task.id}" produced no repository changes`)
    }
    const violations = changedPaths.filter((file) => !task.scope.includes(file))
    if (violations.length > 0) {
      const shown = violations.slice(0, 20)
      const remainder = violations.length - shown.length
      throw new Error(
        `task "${task.id}" modified ${violations.length} file(s) outside its exact scope: ${shown.join(", ")}` +
        (remainder > 0 ? `, … and ${remainder} more` : ""),
      )
    }
    if (task.scope.length > 0) await this.git(["add", "--all", "--", ...task.scope], workspace)
    // Materialization nodes commit compiler-owned bytes exactly. Those bytes
    // may intentionally preserve source/oracle trailing blank lines, so the
    // agent-facing whitespace policy must not reinterpret them. Agent output
    // remains subject to Git's whitespace-error check.
    if (task.executor !== "materialize") {
      const whitespace = await runProcess(this.gitCli, ["diff", "--cached", "--check"], { cwd: workspace, timeoutMs: 120_000 })
      if (!whitespace.ok) throw commandFailure(whitespace)
    }
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
      const ancestor = await runProcess(this.gitCli, ["merge-base", "--is-ancestor", remote, headSha], { cwd: workspace })
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
    const result = await runProcess(this.gitCli, ["worktree", "remove", "--force", target], {
      cwd: this.repoRoot,
      timeoutMs: 120_000,
    })
    if (!result.ok) throw commandFailure(result)
  }
}
