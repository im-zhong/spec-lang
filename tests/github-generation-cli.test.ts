import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { assertGitHubGenerationCheckout } from "../packages/cli/src/generate-github"

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

describe("GitHub generator checkout gate", () => {
  it("accepts only a clean, published commit from the asserted repository", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "spec-generate-gate-"))
    const source = path.join(temporary, "source")
    const remote = path.join(temporary, "github.com", "owner", "repo.git")
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(path.dirname(remote), { recursive: true })
    git(temporary, ["init", "--bare", remote])
    git(source, ["init", "-b", "main"])
    git(source, ["config", "user.name", "test"])
    git(source, ["config", "user.email", "test@example.com"])
    fs.writeFileSync(path.join(source, "spec.ts"), "export default {}\n")
    git(source, ["add", "spec.ts"])
    git(source, ["commit", "-m", "base"])
    git(source, ["remote", "add", "origin", remote])
    git(source, ["push", "-u", "origin", "main"])

    expect(assertGitHubGenerationCheckout(source, "owner/repo")).toMatchObject({ repository: "owner/repo" })
    expect(() => assertGitHubGenerationCheckout(source, "someone/else")).toThrow(/repository mismatch/)

    fs.writeFileSync(path.join(source, "untracked.txt"), "discard me\n")
    expect(() => assertGitHubGenerationCheckout(source)).toThrow(/completely clean/)
    fs.rmSync(path.join(source, "untracked.txt"))

    fs.writeFileSync(path.join(source, "spec.ts"), "export default { changed: true }\n")
    git(source, ["add", "spec.ts"])
    git(source, ["commit", "-m", "unpublished"])
    expect(() => assertGitHubGenerationCheckout(source)).toThrow(/not published/)
  })
})
