import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { compile, stableStringify } from "@spec/compiler"
import { planGeneration } from "@spec/fastapi"

const ROOT = path.resolve(__dirname, "..")
const ENTRY = "examples/media-platform/app.spec.ts"

describe("infrastructure spec packages", () => {
  it("compiles the complex acceptance app with every new package", async () => {
    const result = await compile(ENTRY, { projectRoot: ROOT })
    expect(result.ok, stableStringify(result.diagnostics)).toBe(true)

    const packageNames = result.ir.packages.map((pkg) => pkg.name)
    expect(packageNames).toEqual(expect.arrayContaining([
      "@spec/cache", "@spec/redis", "@spec/messaging", "@spec/rabbitmq",
      "@spec/kafka", "@spec/sqs", "@spec/blob", "@spec/s3",
    ]))
    expect(result.ir.version).toBe("spec-ir/0.3")

    const contributionPackages = result.ir.generation.contributions.map((item) => item.package)
    expect(contributionPackages).toEqual([
      "@spec/blob", "@spec/cache", "@spec/fastapi", "@spec/kafka",
      "@spec/messaging", "@spec/rabbitmq", "@spec/redis", "@spec/s3", "@spec/sqs",
    ])

    const sourceLines = fs.readFileSync(path.join(ROOT, ENTRY), "utf8").split("\n").length - 1
    expect(sourceLines).toBeGreaterThanOrEqual(280)
    expect(sourceLines).toBeLessThanOrEqual(360)
  })

  it("lowers every infrastructure contract into dependencies, tasks, prompts, and oracle files", async () => {
    const result = await compile(ENTRY, { projectRoot: ROOT })
    const plan = planGeneration(result.ir)
    expect(plan.blueprint.caches).toHaveLength(3)
    expect(plan.blueprint.messages).toHaveLength(6)
    expect(plan.blueprint.queues.map((item) => item.provider.kind).sort()).toEqual(["kafka", "rabbitmq", "sqs"])
    expect(plan.blueprint.blobs).toHaveLength(3)
    expect(plan.blueprint.stack.dependencies).toMatchObject({
      redis: "8.1.0",
      "aio-pika": "10.0.1",
      aiokafka: "0.14.0",
      boto3: "1.43.85",
    })

    const taskById = new Map(plan.dag.tasks.map((task) => [task.id, task]))
    expect([...taskById.keys()]).toEqual(expect.arrayContaining(["cache", "messaging", "blob", "app"]))
    expect(taskById.get("cache")!.prompt).toContain("@spec/redis · redis-python")
    expect(taskById.get("messaging")!.prompt).toContain("@spec/kafka · kafka-python")
    expect(taskById.get("blob")!.prompt).toContain("@spec/s3 · s3-python")
    for (const task of plan.dag.tasks) {
      expect(task.prompt).toContain("@spec/fastapi · python-fastapi-baseline")
    }
    expect(Object.keys(plan.conformance.files).sort()).toEqual([
      "conformance/behavior_snapshot.py",
      "conformance/conftest.py",
      "conformance/contract.json",
      "conformance/helpers.py",
      "conformance/test_contract.py",
      "conformance/test_infrastructure.py",
    ])
  })

  it("produces byte-identical IR and generation plans repeatedly", async () => {
    let expected: string | undefined
    for (let index = 0; index < 20; index++) {
      const result = await compile(ENTRY, { projectRoot: ROOT })
      const plan = planGeneration(result.ir)
      const hash = createHash("sha256")
        .update(stableStringify({ ir: result.ir, plan: plan.stable }))
        .digest("hex")
      expected ??= hash
      expect(hash).toBe(expected)
    }
  })

  it("generates syntactically valid compiler-owned Python probes", async () => {
    const result = await compile(ENTRY, { projectRoot: ROOT })
    const plan = planGeneration(result.ir)
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "spec-infra-oracle-"))
    for (const [relative, contents] of Object.entries(plan.conformance.files)) {
      if (!relative.endsWith(".py")) continue
      const destination = path.join(temporary, path.basename(relative))
      fs.writeFileSync(destination, contents)
      expect(() => execFileSync("python3", ["-m", "py_compile", destination])).not.toThrow()
    }
  })
})
