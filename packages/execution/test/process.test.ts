import { describe, expect, it } from "vitest"
import { commandFailure, runProcess } from "../src/process"

describe("bounded process capture", () => {
  it("retains only the configured stdout/stderr tails", async () => {
    const result = await runProcess(process.execPath, [
      "-e",
      "process.stdout.write('a'.repeat(100)); process.stderr.write('b'.repeat(100))",
    ], { maxOutputBytes: 16 })
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe("a".repeat(16))
    expect(result.stderr).toBe("b".repeat(16))
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
  })

  it("preserves structured stdout when stderr also contains warnings", async () => {
    const result = await runProcess(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify({is_error:true,result:'actual failure'})); process.stderr.write('telemetry warning'); process.exit(1)",
    ])
    const message = commandFailure(result).message
    expect(message).toContain("stderr:\ntelemetry warning")
    expect(message).toContain('stdout:\n{"is_error":true,"result":"actual failure"}')
  })
})
