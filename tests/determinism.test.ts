import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import * as path from "node:path"
import { compile, stableStringify } from "@spec/compiler"

const projectRoot = path.resolve(__dirname, "..")
const entry = path.join("tests", "fixtures", "valid-basic-app", "app.spec.ts")

describe("deterministic build (spec §50)", () => {
  it("produces a byte-identical spec.ir.json across 100 consecutive compiles", async () => {
    let referenceHash: string | undefined
    for (let i = 0; i < 100; i++) {
      const result = await compile(entry, { projectRoot })
      expect(result.ok).toBe(true)
      const hash = createHash("sha256").update(stableStringify(result.ir)).digest("hex")
      if (referenceHash === undefined) {
        referenceHash = hash
      } else {
        expect(hash).toBe(referenceHash)
      }
    }
    expect(referenceHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("contains no nondeterministic metadata (no generatedAt)", async () => {
    const result = await compile(entry, { projectRoot })
    expect(result.ir.metadata.generatedAt).toBeUndefined()
    const serialized = stableStringify(result.ir)
    expect(serialized).not.toMatch(/Date|toISOString|now/)
  })
})
