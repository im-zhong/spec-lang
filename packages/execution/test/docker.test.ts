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
        schemaVersion: "spec-agent-task-loop/0.2",
        maxRounds: 2,
        implementation: { instruction: "write code", scope: ["orders/product/app.ts"] },
        reviewer: { instruction: "review", commands: ["node --check product/app.ts"] },
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

  it("runs the v0.2 loop with one writer and a machine-evidence reviewer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-docker-loop-v02-"))
    const { cli, log } = fakeDocker(root)
    const oldLog = process.env.SPEC_DOCKER_LOG
    process.env.SPEC_DOCKER_LOG = log
    try {
      const workspace = path.join(root, "workspace")
      fs.mkdirSync(workspace)
      const loopTask = task()
      loopTask.scope = ["product/app.ts"]
      loopTask.acceptance.commands = ["node --check product/app.ts"]
      loopTask.loop = {
        schemaVersion: "spec-agent-task-loop/0.2",
        maxRounds: 2,
        implementation: { instruction: "write code", scope: ["product/app.ts"] },
        reviewer: {
          instruction: "review the clause table",
          commands: ["python -B -m pytest -q tests/spec_oracle/test_agent.py"],
          oracleFiles: ["product/tests/spec_oracle/test_agent.py"],
          clauses: [
            { id: "abi:app:exports", statement: "exports the exact surface", node: "agent", kind: "abi", verification: "oracle", level: "api" },
            { id: "review:app:no-extras", statement: "no extra public APIs", node: "agent", kind: "review", verification: "review", level: "api" },
          ],
        },
      }
      const result = await new DockerAgentExecutor({
        dockerCli: cli,
        agentCommand: ["claude", "--writer"],
        reviewerAgentCommand: ["claude", "--reviewer"],
      }).execute(loopTask, workspace)
      expect(result.ok).toBe(true)
      expect(result.costUsd).toBe(0.35)
      expect(result.checks.map((check) => check.name)).toEqual([
        "generation/loop/1/implementation",
        "generation/loop/1/review",
        "generation/container/1",
      ])
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
      expect(calls.filter((args) => args.includes("--writer"))).toHaveLength(1)
      expect(calls.findIndex((args) => args.includes("--reviewer"))).toBeGreaterThan(
        calls.findIndex((args) => args.includes("--writer")),
      )
      const oracleEvidence = calls.find((args) => args[0] === "exec" && args.includes("/bin/sh") && args.some((argument) => typeof argument === "string" && argument.includes("spec_oracle")))
      expect(oracleEvidence).toBeDefined()
    } finally {
      if (oldLog === undefined) delete process.env.SPEC_DOCKER_LOG
      else process.env.SPEC_DOCKER_LOG = oldLog
    }
  })

  it("aborts a v0.2 loop as a spec defect when the writer challenges a clause", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-docker-challenge-"))
    const { cli, log } = fakeDocker(root)
    fs.rmSync(cli)
    fs.writeFileSync(cli, `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
fs.appendFileSync(process.env.SPEC_DOCKER_LOG, JSON.stringify(args) + "\\n")
if (args[0] === "inspect") process.exit(1)
if (args[0] === "exec" && args.includes("--writer")) {
  const challenge = { challenge: { clause: "route:POST /bookings", reason: "clause pins 201 but the schema has no create fields" } }
  process.stdout.write(JSON.stringify({ total_cost_usd: 0.2, result: "Contract defect:\\n" + JSON.stringify(challenge) }) + "\\n")
} else if (args[0] === "exec" && args.includes("--reviewer")) process.stdout.write('{"total_cost_usd":0.1,"approved":true,"feedback":""}\\n')
`, "utf8")
    fs.chmodSync(cli, 0o755)
    const oldLog = process.env.SPEC_DOCKER_LOG
    process.env.SPEC_DOCKER_LOG = log
    try {
      const workspace = path.join(root, "workspace")
      fs.mkdirSync(workspace)
      const loopTask = task()
      loopTask.scope = ["product/app.ts"]
      loopTask.loop = {
        schemaVersion: "spec-agent-task-loop/0.2",
        maxRounds: 3,
        implementation: { instruction: "write code", scope: ["product/app.ts"] },
        reviewer: { instruction: "review", commands: ["python -B -m pytest -q tests/spec_oracle/test_agent.py"] },
      }
      const result = await new DockerAgentExecutor({
        dockerCli: cli,
        agentCommand: ["claude", "--writer"],
        reviewerAgentCommand: ["claude", "--reviewer"],
      }).execute(loopTask, workspace)
      expect(result.ok).toBe(false)
      expect(result.error).toContain("SPEC_CONTRACT_CHALLENGED")
      expect(result.error).toContain("route:POST /bookings")
      expect(result.checks.map((check) => check.name)).toContain("generation/loop/1/challenge")
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
      // A challenge is terminal: no reviewer, no oracle evidence, no retry round.
      expect(calls.filter((args) => args.includes("--reviewer"))).toHaveLength(0)
      expect(calls.filter((args) => args.includes("--writer"))).toHaveLength(1)
    } finally {
      if (oldLog === undefined) delete process.env.SPEC_DOCKER_LOG
      else process.env.SPEC_DOCKER_LOG = oldLog
    }
  })
})
