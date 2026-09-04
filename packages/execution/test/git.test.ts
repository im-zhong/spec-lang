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
        {
          id: "compiler-seed",
          objective: "seed",
          instruction: "materialize exact compiler bytes",
          executor: "materialize",
          materializedFiles: { "truth.txt": "truth\n\n" },
          dependsOn: [],
          scope: ["truth.txt"],
          specNodeIds: [],
        },
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

    const seedTemplate = plan.tasks.find((task) => task.id === "compiler-seed")!
    const seedBase = await repository.materializeIntegrationBase(plan, "compiler-seed", [])
    const seedTask: ResolvedAgentExecutionTask = {
      ...seedTemplate, runId: plan.runId, repository: plan.repository, baseSha: seedBase.sha,
      dependencyHeadShas: {}, baseRef: seedBase.ref, branch: taskBranch(plan, "compiler-seed"),
      environment: plan.environment, acceptance: plan.acceptance,
    }
    const seedWorkspace = await repository.createWorkspace(seedTask)
    fs.writeFileSync(path.join(seedWorkspace, "truth.txt"), "truth\n\n")
    const seedCommit = await repository.commitAndPush(seedTask, seedWorkspace, plan.fingerprint)
    await repository.removeWorkspace(seedWorkspace)
    expect(execFileSync("git", ["show", `${seedCommit.headSha}:truth.txt`], { cwd: source, encoding: "utf8" })).toBe("truth\n\n")
  })

  it("merge-to-main keeps the default branch as the single integration line across the DAG", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "spec-execution-mergemain-"))
    const source = path.join(temporary, "source")
    const bare = path.join(temporary, "remote.git")
    fs.mkdirSync(source)
    git(source, ["init", "-b", "main"])
    git(source, ["config", "user.name", "test"])
    git(source, ["config", "user.email", "test@example.com"])
    fs.writeFileSync(path.join(source, "README.md"), "base\n")
    git(source, ["add", "README.md"])
    git(source, ["commit", "-m", "base"])
    git(temporary, ["init", "--bare", "-b", "main", bare])
    git(source, ["remote", "add", "origin", bare])
    git(source, ["push", "-u", "origin", "main"])
    const rootBaseSha = git(source, ["rev-parse", "HEAD"])
    const hash = "b".repeat(64)
    const plan = createAgentExecutionPlan({
      runId: "team",
      mergePolicy: "merge-to-main",
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
        { id: "a", objective: "a", instruction: "a", dependsOn: [], scope: ["a.txt"], specNodeIds: [] },
        { id: "b", objective: "b", instruction: "b", dependsOn: ["a"], scope: ["b.txt"], specNodeIds: [] },
        { id: "c", objective: "c", instruction: "c", dependsOn: ["a"], scope: ["c.txt"], specNodeIds: [] },
        { id: "d", objective: "d", instruction: "d", dependsOn: ["b", "c"], scope: ["d.txt"], specNodeIds: [] },
      ],
    })
    const repository = new GitAgentExecutionRepository({ repoRoot: source, worktreeRoot: path.join(temporary, "worktrees") })
    await repository.publishPlan(plan)

    const runTask = async (id: string, dependencies: AgentExecutionTaskResult[]) => {
      const template = plan.tasks.find((task) => task.id === id)!
      const base = await repository.materializeIntegrationBase(plan, id, dependencies)
      const resolved: ResolvedAgentExecutionTask = {
        ...template, runId: plan.runId, repository: plan.repository, baseSha: base.sha,
        dependencyHeadShas: Object.fromEntries(dependencies.map((result) => [result.taskId, result.headSha!])),
        baseRef: base.ref, branch: taskBranch(plan, id),
        environment: plan.environment, acceptance: plan.acceptance,
      }
      const workspace = await repository.createWorkspace(resolved)
      fs.writeFileSync(path.join(workspace, `${id}.txt`), `${id}\n`)
      const commit = await repository.commitAndPush(resolved, workspace, plan.fingerprint)
      await repository.removeWorkspace(workspace)
      const merged = await repository.mergeIntoDefaultBranch(plan, id, commit.headSha)
      return { result: { taskId: id, status: "merged" as const, branch: resolved.branch, headSha: commit.headSha, checks: [] }, merged }
    }

    // Root node: base is the bootstrap main head.
    const a = await runTask("a", [])
    expect(a.merged.alreadyMerged).toBe(false)
    const aResult = a.result

    // Siblings b and c both start from a main that already contains a.
    const aOnMain = await repository.materializeIntegrationBase(plan, "b", [aResult])
    const cBaseProbe = await repository.materializeIntegrationBase(plan, "c", [aResult])
    expect(aOnMain.sha).toBe(cBaseProbe.sha)
    expect(git(source, ["show", `${aOnMain.sha}:a.txt`])).toBe("a")

    const b = await runTask("b", [aResult])

    // c is a sibling of b: even though b already landed on main, c's base is
    // still the merge-A commit — the point where ITS dependency closure
    // completed. Scheduling can never leak a sibling's code into a branch.
    const cBase = await repository.materializeIntegrationBase(plan, "c", [aResult])
    expect(cBase.sha).toBe(aOnMain.sha)
    expect(() => git(source, ["show", `${cBase.sha}:b.txt`])).toThrow()

    const c = await runTask("c", [aResult])

    // d starts from the landing of its full closure {b, c}: contains a, b, c.
    const dBase = await repository.materializeIntegrationBase(plan, "d", [b.result, c.result])
    expect(git(source, ["show", `${dBase.sha}:a.txt`])).toBe("a")
    expect(git(source, ["show", `${dBase.sha}:b.txt`])).toBe("b")
    expect(git(source, ["show", `${dBase.sha}:c.txt`])).toBe("c")
    expect(dBase.ref).toBe("main")

    const d = await runTask("d", [b.result, c.result])
    const mainHead = git(source, ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0]!
    expect(git(source, ["show", `${mainHead}:d.txt`])).toBe("d")
    for (const head of [aResult.headSha, b.result.headSha, c.result.headSha, d.result.headSha]) {
      expect(git(source, ["merge-base", "--is-ancestor", head!, mainHead])).toBeDefined()
    }

    // Re-merging an already-landed head is idempotent: resume re-derives it.
    const again = await repository.mergeIntoDefaultBranch(plan, "b", b.result.headSha!)
    expect(again.alreadyMerged).toBe(true)
    expect(again.sha).toBe(mainHead)
  })

  it("merge-to-main refuses to start a node whose dependency has not landed on main", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "spec-execution-mergemain-guard-"))
    const source = path.join(temporary, "source")
    const bare = path.join(temporary, "remote.git")
    fs.mkdirSync(source)
    git(source, ["init", "-b", "main"])
    git(source, ["config", "user.name", "test"])
    git(source, ["config", "user.email", "test@example.com"])
    fs.writeFileSync(path.join(source, "README.md"), "base\n")
    git(source, ["add", "README.md"])
    git(source, ["commit", "-m", "base"])
    git(temporary, ["init", "--bare", "-b", "main", bare])
    git(source, ["remote", "add", "origin", bare])
    git(source, ["push", "-u", "origin", "main"])
    const rootBaseSha = git(source, ["rev-parse", "HEAD"])
    const hash = "b".repeat(64)
    const plan = createAgentExecutionPlan({
      runId: "guard",
      mergePolicy: "merge-to-main",
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
        { id: "parent", objective: "p", instruction: "p", dependsOn: [], scope: ["p.txt"], specNodeIds: [] },
        { id: "child", objective: "c", instruction: "c", dependsOn: ["parent"], scope: ["c.txt"], specNodeIds: [] },
      ],
    })
    const repository = new GitAgentExecutionRepository({ repoRoot: source, worktreeRoot: path.join(temporary, "worktrees") })
    await repository.publishPlan(plan)
    const unLanded = { taskId: "parent", status: "merged" as const, headSha: "f".repeat(40), checks: [] }
    await expect(repository.materializeIntegrationBase(plan, "child", [unLanded]))
      .rejects.toThrow(/has not landed on main/)
  })
})
