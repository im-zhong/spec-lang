import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import {
  TEMPORARY_REPOSITORY_WORKFLOW,
  localShotLocalRoot,
  localShotRepositoryName,
  prepareLocalShotRepository,
  temporaryShotLocalRoot,
  temporaryShotRepositoryName,
  temporaryShotRepositorySshUrl,
} from "../packages/cli/src/generate-github"

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

describe("GitHub generator per-shot repository topology", () => {
  it("derives a distinct remote repository and local checkout for every shot", () => {
    const firstRemote = temporaryShotRepositoryName("owner", "media-golden", "run-7", "shot-1")
    const secondRemote = temporaryShotRepositoryName("owner", "media-golden", "run-7", "shot-2")
    const firstLocal = temporaryShotLocalRoot("/source", "run-7", "shot-1")
    const secondLocal = temporaryShotLocalRoot("/source", "run-7", "shot-2")

    expect(firstRemote).toBe("owner/media-golden-run-7-shot-1")
    expect(secondRemote).toBe("owner/media-golden-run-7-shot-2")
    expect(firstRemote).not.toBe(secondRemote)
    expect(firstLocal).not.toBe(secondLocal)
    expect(path.dirname(firstLocal)).toBe(path.dirname(secondLocal))
  })

  it("uses GitHub SSH-over-443 for every shot remote", () => {
    expect(temporaryShotRepositorySshUrl("owner/media-golden-run-7-shot-1"))
      .toBe("ssh://git@ssh.github.com:443/owner/media-golden-run-7-shot-1.git")
    expect(() => temporaryShotRepositorySshUrl("https://github.com/owner/repo"))
      .toThrow("GitHub-safe owner/name")
  })

  it("bootstraps a required check from the immutable plan and pinned image", () => {
    expect(TEMPORARY_REPOSITORY_WORKFLOW).toContain("name: spec-generation")
    expect(TEMPORARY_REPOSITORY_WORKFLOW).toContain("pull_request:")
    expect(TEMPORARY_REPOSITORY_WORKFLOW).toContain("spec/generate/$run_id/plan")
    expect(TEMPORARY_REPOSITORY_WORKFLOW).toContain(".acceptance.commands[]")
    expect(TEMPORARY_REPOSITORY_WORKFLOW).toContain(".environment.image")
    expect(TEMPORARY_REPOSITORY_WORKFLOW).toContain('docker pull "$image"')
  })
})

describe("Local execution topology", () => {
  it("keeps local shot checkouts outside the source repository", () => {
    const source = path.join("/work", "spec-lang")
    const first = localShotLocalRoot(source, "run-7", "shot-1")
    const second = localShotLocalRoot(source, "run-7", "shot-2")
    // Beside the checkout, never inside it: an inner directory without its
    // own .git makes git status report the outer repository.
    expect(path.dirname(path.dirname(first))).toBe("/work/.spec-local/spec-lang")
    expect(first.startsWith(path.resolve(source))).toBe(false)
    expect(path.dirname(first)).toBe(path.dirname(second))
  })

  it("derives a distinct local repository identity for every shot", () => {
    const first = localShotRepositoryName("tiny-fastapi", "backend", "run-7", "shot-1")
    const second = localShotRepositoryName("tiny-fastapi", "backend", "run-7", "shot-2")
    expect(first).toBe("local/spec-tiny-fastapi-backend-run-7-shot-1")
    expect(first).not.toBe(second)
  })

  it("provisions a bare remote plus clone, bootstraps main, and resumes idempotently", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "spec-local-shot-"))
    const sourceRoot = path.join(temporary, "source")
    const localRoot = path.join(temporary, "repositories", "shot-1")
    fs.mkdirSync(sourceRoot, { recursive: true })
    git(sourceRoot, ["init"])

    const created = prepareLocalShotRepository({
      sourceRoot,
      repository: localShotRepositoryName("tiny-fastapi", "backend", "run-7", "shot-1"),
      localRoot,
      runId: "run-7",
      shot: "shot-1",
      resume: false,
    })
    expect(created.defaultBranch).toBe("main")
    expect(fs.existsSync(`${localRoot}.git`)).toBe(true)
    expect(git(localRoot, ["show", "HEAD:README.md"])).toContain("Disposable local spec generation target")
    const head = created.headSha

    // A second non-resume attempt must refuse instead of mutating durable state.
    expect(() => prepareLocalShotRepository({
      sourceRoot, repository: created.repository, localRoot, runId: "run-7", shot: "shot-1", resume: false,
    })).toThrow(/already exists/)

    const resumed = prepareLocalShotRepository({
      sourceRoot, repository: created.repository, localRoot, runId: "run-7", shot: "shot-1", resume: true,
    })
    expect(resumed.headSha).toBe(head)
  })
})
