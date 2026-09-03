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
      environment: {
        image: `registry/dev@sha256:${"c".repeat(64)}`,
        devcontainerHash: hash,
        toolchainLockHash: hash,
        agent: { model: "test-model", effort: "high", maxTurns: 20, maxConcurrency: 2 },
      },
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
    const fetchHead = path.resolve(fresh, git(fresh, ["rev-parse", "--git-path", "FETCH_HEAD"]))
    const fetchHeadSentinel = "shared FETCH_HEAD must remain untouched\n"
    fs.writeFileSync(fetchHead, fetchHeadSentinel, "utf8")
    expect(await Promise.all(results.map((result) => freshRepository.verifyCommitProvenance(
      result.headSha!,
      result.branch!,
      rootBaseSha,
      plan,
      result.taskId,
    )))).toEqual([true, true])
    expect(fs.readFileSync(fetchHead, "utf8")).toBe(fetchHeadSentinel)

    const retryFresh = path.join(temporary, "retry-fresh")
    git(temporary, ["clone", bare, retryFresh])
    const retryState = path.join(temporary, "fetch-attempts")
    const flakyGit = path.join(temporary, "flaky-git.sh")
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
    fs.writeFileSync(flakyGit, `#!/bin/sh
count=0
if [ -f "${retryState}" ]; then read -r count < "${retryState}"; fi
if [ "$1" = fetch ]; then
  count=$((count + 1))
  printf '%s' "$count" > "${retryState}"
  if [ "$count" -eq 1 ]; then
    printf '%s\n' 'transient transport failure' >&2
    exit 128
  fi
fi
exec "${realGit}" "$@"
`, "utf8")
    fs.chmodSync(flakyGit, 0o755)
    const retryRepository = new GitAgentExecutionRepository({
      repoRoot: retryFresh,
      worktreeRoot: path.join(temporary, "retry-worktrees"),
      gitCli: flakyGit,
    })
    expect(await retryRepository.verifyCommitProvenance(
      results[0].headSha!,
      results[0].branch!,
      rootBaseSha,
      plan,
      results[0].taskId,
    )).toBe(true)
    expect(fs.readFileSync(retryState, "utf8")).toBe("2")

    const first = await repository.materializeIntegrationBase(plan, "child", results)
    const second = await repository.materializeIntegrationBase(plan, "child", [...results].reverse())
    expect(first).toEqual(second)
    expect(first.ref).toBe(taskBaseRef(plan, "child"))
    expect(git(source, ["show", `${first.sha}:left.txt`])).toBe("left")
    expect(git(source, ["show", `${first.sha}:right.txt`])).toBe("right")
  })
})
