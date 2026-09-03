import type { AgentExecutionCheckResult } from "@spec/core"
import { commandFailure, runProcess, type ProcessResult } from "./process"
import type { AgentExecutionGitHubPort, PullRequestRecord } from "./ports"

export interface GitHubCliAdapterOptions {
  cli?: string
  cwd?: string
  checkTimeoutMs?: number
  pollIntervalMs?: number
}

interface GhCheck {
  name?: string
  state?: string
  bucket?: string
  link?: string
}

interface GhPullRequestHead {
  headRefOid?: string
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export class GitHubCliAdapter implements AgentExecutionGitHubPort {
  private readonly options: GitHubCliAdapterOptions

  constructor(options: GitHubCliAdapterOptions = {}) {
    this.options = options
  }

  private async gh(args: string[], allowFailure = false) {
    const result = await runProcess(this.options.cli ?? "gh", args, {
      cwd: this.options.cwd,
      timeoutMs: 120_000,
    })
    if (!result.ok && !allowFailure) throw commandFailure(result)
    return result
  }

  async findPullRequest(repository: string, branch: string): Promise<PullRequestRecord | undefined> {
    const result = await this.gh(["pr", "view", branch, "--repo", repository, "--json", "number,url,state"], true)
    if (!result.ok) return undefined
    const parsed = JSON.parse(result.stdout) as { number: number; url: string; state: string }
    return { number: parsed.number, url: parsed.url, state: parsed.state.toLowerCase() as PullRequestRecord["state"] }
  }

  async upsertPullRequest(input: {
    repository: string
    head: string
    base: string
    title: string
    body: string
  }): Promise<PullRequestRecord> {
    const existing = await this.findPullRequest(input.repository, input.head)
    if (existing) {
      // A merged PR is already a durable successful publication of this
      // immutable task branch. Resume must be able to reconstruct the DAG
      // after local state has disappeared without trying to edit the PR.
      if (existing.state === "merged") return existing
      if (existing.state === "closed") {
        await this.gh(["pr", "reopen", String(existing.number), "--repo", input.repository])
      }
      await this.gh(["pr", "edit", String(existing.number), "--repo", input.repository, "--title", input.title, "--body", input.body])
      return { ...existing, state: "open" }
    }
    let lastFailure: ProcessResult | undefined
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const created = await this.gh([
        "pr", "create", "--repo", input.repository,
        "--head", input.head, "--base", input.base,
        "--title", input.title, "--body", input.body,
      ], true)
      if (!created.ok) lastFailure = created

      // The GraphQL response can be lost after GitHub has accepted the PR.
      // Resolve by immutable head branch before considering another create;
      // GitHub itself then remains the idempotency authority.
      for (let lookup = 1; lookup <= 3; lookup += 1) {
        const record = await this.findPullRequest(input.repository, input.head)
        if (record) return record
        await sleep(250 * lookup)
      }
      if (created.ok) {
        throw new Error(`GitHub CLI created a PR but it could not be resolved: ${created.stdout.trim()}`)
      }
    }
    if (!lastFailure) throw new Error("GitHub CLI failed to create or resolve the pull request")
    throw commandFailure(lastFailure)
  }

  async waitForChecks(input: {
    repository: string
    pullRequest: number
    requiredChecks: string[]
    expectedHeadSha: string
  }): Promise<AgentExecutionCheckResult[]> {
    if (input.requiredChecks.length === 0) return []
    const deadline = Date.now() + (this.options.checkTimeoutMs ?? 30 * 60_000)
    while (Date.now() < deadline) {
      const headResponse = await this.gh([
        "pr", "view", String(input.pullRequest), "--repo", input.repository,
        "--json", "headRefOid",
      ], true)
      let head: GhPullRequestHead = {}
      try {
        head = JSON.parse(headResponse.stdout) as GhPullRequestHead
      } catch {
        head = {}
      }
      if (head.headRefOid !== input.expectedHeadSha) {
        await sleep(this.options.pollIntervalMs ?? 5000)
        continue
      }
      const response = await this.gh([
        "pr", "checks", String(input.pullRequest), "--repo", input.repository,
        "--json", "name,state,bucket,link",
      ], true)
      let raw: GhCheck[] = []
      try {
        raw = JSON.parse(response.stdout) as GhCheck[]
      } catch {
        raw = []
      }
      const checks = input.requiredChecks.map((required): AgentExecutionCheckResult => {
        const found = raw.find((item) => item.name === required)
        const bucket = found?.bucket?.toLowerCase()
        const state = found?.state?.toLowerCase()
        const status = bucket === "pass" || state === "success"
          ? "success"
          : bucket === "fail" || bucket === "cancel" || state === "failure" || state === "cancelled"
            ? "failure"
            : found ? "in_progress" : "queued"
        return { name: required, status, ...(found?.link ? { url: found.link } : {}) }
      })
      if (checks.some((check) => check.status === "failure")) return checks
      if (checks.every((check) => check.status === "success")) return checks
      await sleep(this.options.pollIntervalMs ?? 5000)
    }
    return input.requiredChecks.map((name) => ({ name, status: "failure" as const }))
  }

  async enqueuePullRequest(repository: string, pullRequest: number): Promise<void> {
    await this.gh(["pr", "merge", String(pullRequest), "--repo", repository, "--auto", "--merge"])
  }
}
