import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { AgentExecutionTaskResult, ResolvedAgentExecutionTask } from "@spec/core"
import { createAgentExecutionPlan, GitAgentExecutionRepository, taskBaseRef, taskBranch } from "../src"

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

describe("Git agent execution repository", () => {
  it("publishes immutable task commits and a deterministic multi-parent integration base", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "spec-execution-git-"))
    const source = path.join(temporary, "source")
    const bare = path.join(temporary, "remote.git")
    fs.mkdirSync(source)
    git(source, ["init", "-b", "main"])
    git(source, ["config", "user.name", "test"])
    git(source, ["config", "user.email", "test@example.com"])
    fs.writeFileSync(path.join(source, "README.md"), "base\n")
    git(source, ["add", "README.md"])
    git(source, ["commit", "-m", "base"])
    git(temporary, ["init", "--bare", bare])
    git(source, ["remote", "add", "origin", bare])
    git(source, ["push", "-u", "origin", "main"])
    const rootBaseSha = git(source, ["rev-parse", "HEAD"])
    const hash = "b".repeat(64)
    const plan = createAgentExecutionPlan({
      runId: "git-test",
      repository: "owner/repo",
      rootBaseSha,
      environment: { image: `registry/dev@sha256:${"c".repeat(64)}`, devcontainerHash: hash, toolchainLockHash: hash },
      acceptance: { requiredChecks: ["test"], commands: ["true"] },
      tasks: [
        { id: "left", objective: "left", instruction: "left", dependsOn: [], scope: ["left.txt"], specNodeIds: [] },
        { id: "right", objective: "right", instruction: "right", dependsOn: [], scope: ["right.txt"], specNodeIds: [] },
        { id: "child", objective: "child", instruction: "child", dependsOn: ["left", "right"], scope: ["child.txt"], specNodeIds: [] },
      ],
    })
    const repository = new GitAgentExecutionRepository({ repoRoot: source, worktreeRoot: path.join(temporary, "worktrees") })
    const published = await repository.publishPlan(plan)
    expect(published.ref).toBe("spec/generate/git-test/plan")
    expect(git(source, ["show", `${published.sha}:plan.json`])).toContain(`"fingerprint": "${plan.fingerprint}"`)
    await expect(repository.publishPlan(plan)).resolves.toEqual(published)

    const results: AgentExecutionTaskResult[] = []
    for (const id of ["left", "right"]) {
      const template = plan.tasks.find((task) => task.id === id)!
      const base = await repository.materializeIntegrationBase(plan, id, [])
      const resolved: ResolvedAgentExecutionTask = {
        ...template, runId: plan.runId, repository: plan.repository, baseSha: base.sha,
        dependencyHeadShas: {}, baseRef: base.ref, branch: taskBranch(plan, id),
        environment: plan.environment, acceptance: plan.acceptance,
      }
      const workspace = await repository.createWorkspace(resolved)
      fs.writeFileSync(path.join(workspace, `${id}.txt`), `${id}\n`)
      const commit = await repository.commitAndPush(resolved, workspace, plan.fingerprint)
      await repository.removeWorkspace(workspace)
      results.push({ taskId: id, status: "review", branch: resolved.branch, headSha: commit.headSha, checks: [] })
      expect(await repository.verifyCommitProvenance(commit.headSha, resolved.branch, base.sha, plan, id)).toBe(true)
    }

    const fresh = path.join(temporary, "fresh")
    git(temporary, ["clone", bare, fresh])
    const freshRepository = new GitAgentExecutionRepository({ repoRoot: fresh, worktreeRoot: path.join(temporary, "fresh-worktrees") })
    expect(await freshRepository.verifyCommitProvenance(
      results[0].headSha!,
      results[0].branch!,
      rootBaseSha,
      plan,
      results[0].taskId,
    )).toBe(true)

    const first = await repository.materializeIntegrationBase(plan, "child", results)
    const second = await repository.materializeIntegrationBase(plan, "child", [...results].reverse())
    expect(first).toEqual(second)
    expect(first.ref).toBe(taskBaseRef(plan, "child"))
    expect(git(source, ["show", `${first.sha}:left.txt`])).toBe("left")
    expect(git(source, ["show", `${first.sha}:right.txt`])).toBe("right")
  })
})
