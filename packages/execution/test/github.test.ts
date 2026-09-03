import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { GitHubCliAdapter } from "../src/github"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe("GitHub CLI adapter", () => {
  it("treats an already merged immutable task PR as a resumable durable result", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spec-github-adapter-"))
    temporaryDirectories.push(directory)
    const log = path.join(directory, "calls.log")
    const cli = path.join(directory, "gh")
    fs.writeFileSync(cli, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
printf '%s\\n' '{"number":42,"url":"https://github.test/pull/42","state":"MERGED"}'
`, { mode: 0o755 })

    const adapter = new GitHubCliAdapter({ cli })
    const pullRequest = await adapter.upsertPullRequest({
      repository: "owner/repository",
      head: "spec/generate/run/task",
      base: "main",
      title: "task",
      body: "body",
    })

    expect(pullRequest).toEqual({
      number: 42,
      url: "https://github.test/pull/42",
      state: "merged",
    })
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1)
  })

  it("recovers idempotently when PR creation returns EOF after server acceptance", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spec-github-adapter-"))
    temporaryDirectories.push(directory)
    const log = path.join(directory, "calls.log")
    const accepted = path.join(directory, "accepted")
    const cli = path.join(directory, "gh")
    fs.writeFileSync(cli, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1 $2" = "pr view" ]; then
  if [ -f ${JSON.stringify(accepted)} ]; then
    printf '%s\\n' '{"number":7,"url":"https://github.test/pull/7","state":"OPEN"}'
    exit 0
  fi
  exit 1
fi
if [ "$1 $2" = "pr create" ]; then
  touch ${JSON.stringify(accepted)}
  printf '%s\\n' 'Post "https://api.github.com/graphql": EOF' >&2
  exit 1
fi
exit 2
`, { mode: 0o755 })

    const adapter = new GitHubCliAdapter({ cli })
    await expect(adapter.upsertPullRequest({
      repository: "owner/repository",
      head: "spec/generate/run/task",
      base: "main",
      title: "task",
      body: "body",
    })).resolves.toEqual({
      number: 7,
      url: "https://github.test/pull/7",
      state: "open",
    })

    const calls = fs.readFileSync(log, "utf8").trim().split("\n")
    expect(calls.filter((call) => call.startsWith("pr create "))).toHaveLength(1)
  })
})
