import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import type { ResolvedAgentExecutionTask } from "@spec/core"
import { DockerAgentExecutor } from "../src"

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
    repository: "owner/repo",
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

function fakeDocker(root: string): { cli: string; log: string } {
  const cli = path.join(root, "docker-fake.mjs")
  const log = path.join(root, "docker.log")
  fs.writeFileSync(cli, `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(process.env.SPEC_DOCKER_LOG, JSON.stringify(args) + "\\n")
if (args[0] === "inspect") process.exit(1)
if (args[0] === "start" && process.env.SPEC_FAIL_START === "1") process.exit(2)
if (args[0] === "exec" && args.includes("--reviewer")) process.stdout.write('telemetry warning\\n{"total_cost_usd":0.1,"approved":true,"feedback":""}\\n')
else if (args[0] === "exec" && args.includes("claude")) process.stdout.write('{"total_cost_usd":0.25}\\n')
`, "utf8")
  fs.chmodSync(cli, 0o755)
  return { cli, log }
}

describe("Docker agent executor", () => {
  it("mounts credentials read-only only for agent nodes and always removes containers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-docker-executor-"))
    const { cli, log } = fakeDocker(root)
    const previous = process.env.SPEC_DOCKER_LOG
    process.env.SPEC_DOCKER_LOG = log
    try {
      const secret = path.join(root, "secret")
      fs.writeFileSync(secret, "secret")
      const executor = new DockerAgentExecutor({
        dockerCli: cli,
        mounts: [{ source: secret, target: "/opt/secret", readOnly: true }],
        environmentVariables: ["ANTHROPIC_API_KEY"],
        agentCommand: ["claude", "-p"],
      })
      const agentWorkspace = path.join(root, "agent-workspace")
      fs.mkdirSync(agentWorkspace)
      const agent = await executor.execute(task("agent"), agentWorkspace)
      expect(agent.ok).toBe(true)
      expect(agent.costUsd).toBe(0.25)

      const materializeWorkspace = path.join(root, "materialize-workspace")
      fs.mkdirSync(materializeWorkspace)
      const materialized = await executor.execute(task("materialize"), materializeWorkspace)
      expect(materialized.ok).toBe(true)
      expect(fs.readFileSync(path.join(materializeWorkspace, "product/oracle.txt"), "utf8")).toBe("truth\n")

      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
      const creates = calls.filter((args) => args[0] === "create")
      expect(creates[0].join(" ")).toContain("target=/opt/secret,readonly")
      expect(creates[0]).toContain("ANTHROPIC_API_KEY")
      expect(creates[1].join(" ")).not.toContain("/opt/secret")
      expect(creates[1]).not.toContain("ANTHROPIC_API_KEY")
      expect(calls.filter((args) => args[0] === "rm")).toHaveLength(2)
    } finally {
      if (previous === undefined) delete process.env.SPEC_DOCKER_LOG
      else process.env.SPEC_DOCKER_LOG = previous
    }
  })

  it("removes a created container when start fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-docker-start-"))
    const { cli, log } = fakeDocker(root)
    const oldLog = process.env.SPEC_DOCKER_LOG
    const oldFail = process.env.SPEC_FAIL_START
    process.env.SPEC_DOCKER_LOG = log
    process.env.SPEC_FAIL_START = "1"
    try {
      const workspace = path.join(root, "workspace")
      fs.mkdirSync(workspace)
      const result = await new DockerAgentExecutor({ dockerCli: cli }).execute(task(), workspace)
      expect(result.ok).toBe(false)
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
      expect(calls.map((args) => args[0])).toEqual(["inspect", "create", "start", "rm"])
    } finally {
      if (oldLog === undefined) delete process.env.SPEC_DOCKER_LOG
      else process.env.SPEC_DOCKER_LOG = oldLog
      if (oldFail === undefined) delete process.env.SPEC_FAIL_START
      else process.env.SPEC_FAIL_START = oldFail
    }
  })

  it("runs implementation and tests before a read-only reviewer, then judges once", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-docker-loop-"))
    const { cli, log } = fakeDocker(root)
    const oldLog = process.env.SPEC_DOCKER_LOG
    process.env.SPEC_DOCKER_LOG = log
    try {
      const workspace = path.join(root, "workspace")
      fs.mkdirSync(workspace)
      const loopTask = task()
      loopTask.scope = ["product/app.ts", "product/app.test.ts"]
      loopTask.acceptance.commands = ["node --test app.test.ts"]
      loopTask.loop = {
        schemaVersion: "spec-agent-task-loop/0.1",
        maxRounds: 2,
        implementation: { instruction: "write code", scope: ["product/app.ts"] },
        tests: { instruction: "write tests", scope: ["product/app.test.ts"] },
        reviewer: { instruction: "review", commands: ["node --test app.test.ts"] },
      }
      const result = await new DockerAgentExecutor({
        dockerCli: cli,
        agentCommand: ["claude", "--writer"],
        reviewerAgentCommand: ["claude", "--reviewer"],
      }).execute(loopTask, workspace)
      expect(result.ok).toBe(true)
      expect(result.costUsd).toBe(0.6)
      expect(result.checks.map((check) => check.name)).toEqual([
        "generation/loop/1/implementation",
        "generation/loop/1/tests",
        "generation/loop/1/review",
        "generation/container/1",
      ])
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
      const writerIndexes = calls.map((args, index) => args.includes("--writer") ? index : -1).filter((index) => index >= 0)
      const reviewerIndex = calls.findIndex((args) => args.includes("--reviewer"))
      expect(writerIndexes).toHaveLength(2)
      expect(Math.max(...writerIndexes)).toBeLessThan(reviewerIndex)
    } finally {
      if (oldLog === undefined) delete process.env.SPEC_DOCKER_LOG
      else process.env.SPEC_DOCKER_LOG = oldLog
    }
  })
})
