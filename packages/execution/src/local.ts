import * as fs from "node:fs"
import * as path from "node:path"
import type { AgentExecutionCheckResult } from "@spec/core"
import { commandFailure, runProcess, type ProcessResult } from "./process"
import type {
  AgentExecutionControlPlanePort,
  PullRequestRecord,
  WaitForChecksInput,
} from "./ports"

export interface LocalGitControlPlaneOptions {
  /** Shot checkout whose object store (shared with its worktrees) backs verification. */
  repoRoot: string
  /** Root under which detached verification worktrees are created and removed. */
  verificationRoot: string
  /** Test seam; production uses `git`. */
  gitCli?: string
}

/**
 * Control plane for a plain local Git remote: pull requests are synthetic
 * records (there is no GitHub), and a required check is verified exactly the
 * way the GitHub workflow verifies it — a fresh checkout of the pushed head,
 * then the task's frozen acceptance commands — except the checkout is a
 * detached worktree on this machine instead of a CI runner.
 */
export class LocalGitControlPlane implements AgentExecutionControlPlanePort {
  private readonly repoRoot: string
  private readonly verificationRoot: string
  private readonly gitCli: string
  private readonly pullRequests = new Map<string, PullRequestRecord>()
  private counter = 0

  constructor(options: LocalGitControlPlaneOptions) {
    this.repoRoot = path.resolve(options.repoRoot)
    this.verificationRoot = path.resolve(options.verificationRoot)
    this.gitCli = options.gitCli ?? "git"
  }

  private async git(args: string[], cwd = this.repoRoot): Promise<ProcessResult> {
    const result = await runProcess(this.gitCli, args, { cwd, env: process.env, timeoutMs: 180_000 })
    if (!result.ok) throw commandFailure(result)
    return result
  }

  async findPullRequest(_repository: string, branch: string): Promise<PullRequestRecord | undefined> {
    return this.pullRequests.get(branch)
  }

  async upsertPullRequest(input: {
    repository: string
    head: string
    base: string
    title: string
    body: string
  }): Promise<PullRequestRecord> {
    const existing = this.pullRequests.get(input.head)
    if (existing) return existing
    const number = ++this.counter
    const record: PullRequestRecord = { number, url: `local://${input.repository}#${input.head}`, state: "open" }
    this.pullRequests.set(input.head, record)
    return record
  }

  async waitForChecks(input: WaitForChecksInput): Promise<AgentExecutionCheckResult[]> {
    if (input.requiredChecks.length === 0) return []
    fs.mkdirSync(this.verificationRoot, { recursive: true })
    const workspace = path.join(this.verificationRoot, `verify-${input.expectedHeadSha}`)
    if (fs.existsSync(workspace)) await this.removeWorkspace(workspace)
    await this.git(["worktree", "add", "--detach", workspace, input.expectedHeadSha])
    try {
      const workdir = input.acceptance.workingDirectory
        ? path.join(workspace, input.acceptance.workingDirectory)
        : workspace
      fs.mkdirSync(workdir, { recursive: true })
      for (let index = 0; index < input.acceptance.commands.length; index++) {
        const command = input.acceptance.commands[index]
        const result = await runProcess("/bin/sh", ["-lc", command], {
          cwd: workdir,
          timeoutMs: 45 * 60_000,
        })
        if (!result.ok) {
          throw new Error(
            `local check for ${input.repository}@${input.expectedHeadSha} failed on acceptance command ` +
            `${JSON.stringify(command)} (exit ${String(result.exitCode)}): ${(result.stderr + "\n" + result.stdout).slice(-4000)}`,
          )
        }
      }
    } finally {
      await this.removeWorkspace(workspace)
    }
    return input.requiredChecks.map((name) => ({ name, status: "success" as const }))
  }

  private async removeWorkspace(workspace: string): Promise<void> {
    const target = path.resolve(workspace)
    const root = this.verificationRoot.endsWith(path.sep) ? this.verificationRoot : `${this.verificationRoot}${path.sep}`
    if (!target.startsWith(root)) throw new Error(`refusing to remove verification worktree outside ${this.verificationRoot}: ${target}`)
    if (!fs.existsSync(target)) return
    const result = await runProcess(this.gitCli, ["worktree", "remove", "--force", target], {
      cwd: this.repoRoot,
      timeoutMs: 120_000,
    })
    if (!result.ok) throw commandFailure(result)
  }

  async enqueuePullRequest(): Promise<void> {
    throw new Error("merge-queue policy requires the GitHub control plane; local execution uses --merge-policy merge-to-main")
  }
}
