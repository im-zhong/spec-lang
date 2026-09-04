import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { LocalGitControlPlane } from "../src"

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function fixture(): { source: string; temporary: string } {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "spec-local-control-"))
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
  return { source, temporary }
}

describe("Local Git control plane", () => {
  it("verifies a pushed head by replaying the frozen acceptance in a fresh detached worktree", async () => {
    const { source, temporary } = fixture()
    fs.mkdirSync(path.join(source, "product"), { recursive: true })
    fs.writeFileSync(path.join(source, "product/answer.txt"), "42\n")
    git(source, ["add", "."])
    git(source, ["commit", "-m", "task output"])
    const headSha = git(source, ["rev-parse", "HEAD"])
    git(source, ["push", "origin", `HEAD:refs/heads/spec/generate/run/task`])
    const verificationRoot = path.join(temporary, "verification")
    const plane = new LocalGitControlPlane({ repoRoot: source, verificationRoot })

    const pullRequest = await plane.upsertPullRequest({ repository: "local/run", head: "spec/generate/run/task", base: "main", title: "t", body: "b" })
    expect(await plane.upsertPullRequest({ repository: "local/run", head: "spec/generate/run/task", base: "main", title: "t", body: "b" })).toEqual(pullRequest)
    expect(await plane.findPullRequest("local/run", "spec/generate/run/task")).toBeDefined()

    const checks = await plane.waitForChecks({
      repository: "local/run",
      pullRequest: pullRequest.number,
      requiredChecks: ["spec-generation"],
      expectedHeadSha: headSha,
      acceptance: { commands: ["test \"$(cat answer.txt)\" = 42"], workingDirectory: "product" },
    })
    expect(checks).toEqual([{ name: "spec-generation", status: "success" }])
    // The verification worktree is disposable: nothing survives the check.
    expect(fs.readdirSync(verificationRoot)).toEqual([])
  })

  it("fails loud with command output when the pushed head does not satisfy acceptance", async () => {
    const { source, temporary } = fixture()
    const headSha = git(source, ["rev-parse", "HEAD"])
    const plane = new LocalGitControlPlane({ repoRoot: source, verificationRoot: path.join(temporary, "verification") })
    await expect(plane.waitForChecks({
      repository: "local/run",
      pullRequest: 1,
      requiredChecks: ["spec-generation"],
      expectedHeadSha: headSha,
      acceptance: { commands: ["test -f does-not-exist.txt"] },
    })).rejects.toThrow(/local check for local\/run@[0-9a-f]+ failed on acceptance command/)
    expect(fs.readdirSync(path.join(temporary, "verification"))).toEqual([])
  })

  it("refuses merge-queue enqueue because that policy needs GitHub", async () => {
    const { source, temporary } = fixture()
    const plane = new LocalGitControlPlane({ repoRoot: source, verificationRoot: path.join(temporary, "verification") })
    await expect(plane.enqueuePullRequest("local/run", 1)).rejects.toThrow(/merge-queue policy requires the GitHub control plane/)
  })
})
