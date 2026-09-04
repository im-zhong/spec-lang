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

  it("merges loop writes, ignores interpreter artifacts, and forwards literal environment", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-docker-scope-"))
    const cli = path.join(root, "docker-fake.mjs")
    const log = path.join(root, "docker.log")
    fs.writeFileSync(cli, `#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
const args = process.argv.slice(2)
fs.appendFileSync(process.env.SPEC_DOCKER_LOG, JSON.stringify(args) + "\\n")
if (args[0] === "inspect") process.exit(1)
if (args[0] === "exec" && args.includes("--reviewer")) process.stdout.write('{"total_cost_usd":0.1,"approved":true,"feedback":""}\\n')
else if (args[0] === "exec" && args.includes("claude")) {
  const index = args.indexOf("-w")
  const workdir = index >= 0 ? args[index + 1] : ""
  if (workdir.includes(".spec-loop") && process.env.SPEC_FAKE_WS) {
    const local = workdir.replace(/^\\/workspace/, process.env.SPEC_FAKE_WS)
    fs.mkdirSync(path.join(local, "product/__pycache__"), { recursive: true })
    if (local.endsWith("/implementation")) {
      fs.writeFileSync(path.join(local, "product/app.ts"), "code\\n")
      fs.writeFileSync(path.join(local, "product/__pycache__/app.cpython-313.pyc"), "bytecode\\n")
    } else if (local.endsWith("/tests")) {
      fs.writeFileSync(path.join(local, "product/app.test.ts"), "tests\\n")
    }
  }
  process.stdout.write('{"total_cost_usd":0.25}\\n')
}
`, "utf8")
    fs.chmodSync(cli, 0o755)
    const previous = process.env.SPEC_DOCKER_LOG
    const previousWorkspace = process.env.SPEC_FAKE_WS
    process.env.SPEC_DOCKER_LOG = log
    try {
      const workspace = path.join(root, "workspace")
      fs.mkdirSync(workspace)
      process.env.SPEC_FAKE_WS = workspace
      const loopTask = task()
      loopTask.workingDirectory = "orders"
      loopTask.scope = ["orders/product/app.ts", "orders/product/app.test.ts"]
      loopTask.loop = {
        schemaVersion: "spec-agent-task-loop/0.1",
        maxRounds: 2,
        implementation: { instruction: "write code", scope: ["orders/product/app.ts"] },
        tests: { instruction: "write tests", scope: ["orders/product/app.test.ts"] },
        reviewer: { instruction: "review", commands: ["node --test app.test.ts"] },
      }
      const result = await new DockerAgentExecutor({
        dockerCli: cli,
        agentCommand: ["claude", "--writer"],
        reviewerAgentCommand: ["claude", "--reviewer"],
        literalEnvironment: { PYTHONDONTWRITEBYTECODE: "1" },
      }).execute(loopTask, workspace)
      expect(result.ok).toBe(true)
      expect(fs.readFileSync(path.join(workspace, "orders/product/app.ts"), "utf8")).toBe("code\n")
      expect(fs.readFileSync(path.join(workspace, "orders/product/app.test.ts"), "utf8")).toBe("tests\n")
      expect(fs.existsSync(path.join(workspace, "orders/product/__pycache__"))).toBe(false)
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
      const create = calls.find((args) => args[0] === "create")!
      expect(create).toContain("PYTHONDONTWRITEBYTECODE=1")
    } finally {
      if (previous === undefined) delete process.env.SPEC_DOCKER_LOG
      else process.env.SPEC_DOCKER_LOG = previous
      if (previousWorkspace === undefined) delete process.env.SPEC_FAKE_WS
      else process.env.SPEC_FAKE_WS = previousWorkspace
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

  it("extracts reviewer verdicts fenced or wrapped in prose inside the result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-docker-verdict-"))
    const { cli, log } = fakeDocker(root)
    // Wrap the reviewer's verdict the way weak models do: prose plus a
    // markdown fence inside the agent envelope's result string.
    fs.rmSync(cli)
    fs.writeFileSync(cli, `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(process.env.SPEC_DOCKER_LOG, JSON.stringify(args) + "\\n")
if (args[0] === "inspect") process.exit(1)
if (args[0] === "exec" && args.includes("--reviewer")) {
  const verdict = { approved: true, feedback: "conforms" }
  const envelope = { total_cost_usd: 0.1, result: "Final review:\\n\\\`\\\`\\\`json\\n" + JSON.stringify(verdict) + "\\n\\\`\\\`\\\`" }
  process.stdout.write(JSON.stringify(envelope) + "\\n")
} else if (args[0] === "exec" && args.includes("claude")) process.stdout.write('{"total_cost_usd":0.25}\\n')
`, "utf8")
    fs.chmodSync(cli, 0o755)
    const previous = process.env.SPEC_DOCKER_LOG
    process.env.SPEC_DOCKER_LOG = log
    try {
      const workspace = path.join(root, "workspace")
      fs.mkdirSync(workspace)
      const loopTask = task()
      loopTask.workingDirectory = "orders"
      loopTask.loop = {
        schemaVersion: "spec-agent-task-loop/0.1",
        maxRounds: 2,
        implementation: { instruction: "write code", scope: ["orders/product/app.ts"] },
        tests: { instruction: "write tests", scope: ["orders/product/app.test.ts"] },
        reviewer: { instruction: "review", commands: ["true"] },
      }
      const result = await new DockerAgentExecutor({
        dockerCli: cli,
        agentCommand: ["claude", "--writer"],
        reviewerAgentCommand: ["claude", "--reviewer"],
      }).execute(loopTask, workspace)
      expect(result.ok).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.SPEC_DOCKER_LOG
      else process.env.SPEC_DOCKER_LOG = previous
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
        initializationCommand: ["initialize-credentials"],
        agentCommand: ["claude", "--writer"],
        reviewerAgentCommand: ["claude", "--reviewer"],
      }).execute(loopTask, workspace)
      expect(result.ok).toBe(true)
      expect(result.costUsd).toBe(0.6)
      expect(result.checks.map((check) => check.name)).toEqual([
        "generation/initialize",
        "generation/loop/1/implementation",
        "generation/loop/1/tests",
        "generation/loop/1/review",
        "generation/container/1",
      ])
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
      const writerIndexes = calls.map((args, index) => args.includes("--writer") ? index : -1).filter((index) => index >= 0)
      const reviewerIndex = calls.findIndex((args) => args.includes("--reviewer"))
      expect(calls.filter((args) => args.includes("initialize-credentials"))).toHaveLength(1)
      expect(writerIndexes).toHaveLength(2)
      expect(Math.max(...writerIndexes)).toBeLessThan(reviewerIndex)
    } finally {
      if (oldLog === undefined) delete process.env.SPEC_DOCKER_LOG
      else process.env.SPEC_DOCKER_LOG = oldLog
    }
  })
})
