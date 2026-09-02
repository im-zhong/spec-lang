import { describe, expect, it } from "vitest"
import { runAgentExecutionSchedule } from "../src"

const task = (id: string, dependsOn: string[] = []) => ({
  id,
  objective: id,
  instruction: id,
  dependsOn,
  scope: [`${id}.ts`],
  specNodeIds: [],
})

describe("agent execution scheduler", () => {
  it("runs independent ready tasks concurrently and gates their child", async () => {
    const active = new Set<string>()
    let observedParallel = false
    const started: string[] = []
    const report = await runAgentExecutionSchedule(
      [task("left"), task("right"), task("child", ["left", "right"])],
      async (current, dependencies) => {
        started.push(current.id)
        active.add(current.id)
        if (active.has("left") && active.has("right")) observedParallel = true
        if (current.id === "child") expect(dependencies.map((item) => item.taskId).sort()).toEqual(["left", "right"])
        await new Promise((resolve) => setTimeout(resolve, 15))
        active.delete(current.id)
        return { taskId: current.id, ok: true }
      },
      { concurrency: 2 },
    )
    expect(observedParallel).toBe(true)
    expect(started.slice(0, 2).sort()).toEqual(["left", "right"])
    expect(started[2]).toBe("child")
    expect(report.ok).toBe(true)
  })

  it("does not run descendants of a failed task", async () => {
    const report = await runAgentExecutionSchedule(
      [task("root"), task("child", ["root"])],
      async (current) => ({ taskId: current.id, ok: current.id !== "root" }),
    )
    expect(report.ok).toBe(false)
    expect(report.results.map((item) => item.taskId)).toEqual(["root"])
    expect(report.skipped).toEqual(["child"])
  })

  it("records worker rejection and waits for already-running siblings", async () => {
    let siblingFinished = false
    const report = await runAgentExecutionSchedule(
      [task("left"), task("right"), task("child", ["right"])],
      async (current) => {
        if (current.id === "left") throw new Error("cleanup exploded")
        await new Promise((resolve) => setTimeout(resolve, 25))
        siblingFinished = true
        return { taskId: current.id, ok: true }
      },
      { concurrency: 2 },
    )
    expect(siblingFinished).toBe(true)
    expect(report.ok).toBe(false)
    expect(report.failures).toMatchObject([{ taskId: "left", phase: "worker", message: "cleanup exploded" }])
    expect(report.skipped).toContain("child")
  })
})
