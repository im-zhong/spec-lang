import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import type { ResolvedAgentExecutionTask } from "@spec/core"
import { HostAgentExecutor } from "../src"

function task(executor: "agent" | "materialize" = "agent"): ResolvedAgentExecutionTask {
  return {
    id: executor,
    objective: executor,
    instruction: "implement",
    executor,
    ...(executor === "materialize" ? { materializedFiles: { "oracle.txt": "truth\n" } } : {}),
    dependsOn: [],
    workingDirectory: "product",
    scope: [`product/${executor === "materialize" ? "oracle.txt" : "app.ts"}`],
    specNodeIds: [],
    runId: "run",
    repository: "local/run",
    baseSha: "a".repeat(40),
    dependencyHeadShas: {},
    baseRef: "spec/generate/run/bases/task",
    branch: `spec/generate/run/${executor}`,
    environment: {
      image: `registry/agent@sha256:${"b".repeat(64)}`,
      devcontainerHash: "c".repeat(64),
      toolchainLockHash: "d".repeat(64),
      agent: { model: "test-model", effort: "high", maxTurns: 20, maxConcurrency: 1 },
    },
    acceptance: { requiredChecks: ["spec-generation"], commands: ["true"] },
  }
}

/** A fake `claude` CLI: logs argv, writes a file for the writer role, and answers the reviewer with a verdict. */
function fakeClaude(root: string): { dir: string; log: string } {
  const dir = path.join(root, "fake-bin")
  const log = path.join(root, "claude.log")
  fs.mkdirSync(dir, { recursive: true })
  const cli = path.join(dir, "claude")
  fs.writeFileSync(cli, `#!/bin/sh
printf '%s\\n' "$*" >> "\${SPEC_HOST_CLAUDE_LOG:-/dev/null}"
prompt="$(cat)"
case "$1" in
  --writer)
    printf 'export const app = 1\\n' > app.ts
    printf '{"total_cost_usd":0.25}\\n'
    ;;
  --reviewer)
    cat <<'JSON'
{"total_cost_usd":0.1,"result":"{\\"approved\\":true,\\"feedback\\":\\"\\"}"}
JSON
    ;;
  *)
    printf '{"total_cost_usd":0.5}\\n'
    ;;
esac
`, "utf8")
  fs.chmodSync(cli, 0o755)
  return { dir, log }
}

describe("Host agent executor", () => {
  it("runs the v0.2 loop and acceptance directly on the host in the task worktree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-host-executor-"))
    const { dir, log } = fakeClaude(root)
    const previous = process.env.SPEC_HOST_CLAUDE_LOG
    process.env.SPEC_HOST_CLAUDE_LOG = log
    try {
    const workspace = path.join(root, "workspace")
    fs.mkdirSync(workspace)
    const loopTask = task()
    loopTask.scope = ["product/app.ts"]
    loopTask.acceptance.commands = ["test -f app.ts"]
    loopTask.loop = {
      schemaVersion: "spec-agent-task-loop/0.2",
      maxRounds: 2,
      implementation: { instruction: "write code", scope: ["product/app.ts"] },
      reviewer: { instruction: "review", commands: ["test -f app.ts"] },
    }
    const result = await new HostAgentExecutor({
      agentCommand: [path.join(dir, "claude"), "--writer"],
      reviewerAgentCommand: [path.join(dir, "claude"), "--reviewer"],
    }).execute(loopTask, workspace)
    expect(result.ok).toBe(true)
    expect(result.costUsd).toBe(0.35)
    expect(result.checks.map((check) => check.name)).toEqual([
      "generation/loop/1/implementation",
      "generation/loop/1/review",
      "generation/acceptance/1",
    ])
    // The writer's output landed in the real host worktree, not a container.
    expect(fs.readFileSync(path.join(workspace, "product/app.ts"), "utf8")).toBe("export const app = 1\n")
    const calls = fs.readFileSync(log, "utf8").trim().split("\n")
    expect(calls.filter((line) => line.includes("--writer"))).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.SPEC_HOST_CLAUDE_LOG
      else process.env.SPEC_HOST_CLAUDE_LOG = previous
    }
  })

  it("fails loud when the agent writes outside its declared scope", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-host-scope-"))
    const dir = path.join(root, "fake-bin")
    fs.mkdirSync(dir, { recursive: true })
    const cli = path.join(dir, "claude")
    fs.writeFileSync(cli, `#!/bin/sh
cat > /dev/null
printf 'smuggled\\n' > smuggled.txt
printf '{"total_cost_usd":0.25}\\n'
`, "utf8")
    fs.chmodSync(cli, 0o755)
    const workspace = path.join(root, "workspace")
    const loopTask = task()
    loopTask.scope = ["product/app.ts"]
    loopTask.loop = {
      schemaVersion: "spec-agent-task-loop/0.2",
      maxRounds: 1,
      implementation: { instruction: "write code", scope: ["product/app.ts"] },
      reviewer: { instruction: "review", commands: ["true"] },
    }
    const result = await new HostAgentExecutor({
      agentCommand: [cli, "--writer"],
      reviewerAgentCommand: [cli, "--reviewer"],
    }).execute(loopTask, workspace)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("wrote outside its declared scope")
  })

  it("materializes compiler-owned bytes without invoking any agent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-host-materialize-"))
    const workspace = path.join(root, "workspace")
    fs.mkdirSync(workspace)
    const result = await new HostAgentExecutor({
      agentCommand: ["/usr/bin/false"],
      reviewerAgentCommand: ["/usr/bin/false"],
    }).execute(task("materialize"), workspace)
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(path.join(workspace, "product/oracle.txt"), "utf8")).toBe("truth\n")
  })

  it("reports a failing acceptance command as a failed check", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-host-acceptance-"))
    const { dir } = fakeClaude(root)
    const workspace = path.join(root, "workspace")
    fs.mkdirSync(workspace)
    const failing = task()
    failing.acceptance.commands = ["exit 3"]
    const result = await new HostAgentExecutor({
      agentCommand: [path.join(dir, "claude")],
    }).execute(failing, workspace)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("exit 3")
  })
})
