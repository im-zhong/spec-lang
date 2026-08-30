import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { compile, stableStringify } from "@spec/compiler"

const projectRoot = path.resolve(__dirname, "..")
const fixturesRoot = path.join(projectRoot, "tests", "fixtures")

const FIXTURES = fs
  .readdirSync(fixturesRoot)
  .filter((name) => fs.existsSync(path.join(fixturesRoot, name, "app.spec.ts")))

describe("golden compiler tests", () => {
  it("has fixtures to check", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(5)
  })

  for (const name of FIXTURES) {
    it(`matches golden output for ${name}`, async () => {
      const entry = path.join("tests", "fixtures", name, "app.spec.ts")
      const result = await compile(entry, { projectRoot })

      const expectedIrPath = path.join(fixturesRoot, name, "expected", "ir.json")
      const expectedDiagnosticsPath = path.join(fixturesRoot, name, "expected", "diagnostics.json")
      const actualIr = stableStringify(result.ir) + "\n"
      const actualDiagnostics = stableStringify(result.diagnostics) + "\n"

      if (process.env.UPDATE_GOLDEN === "1") {
        fs.mkdirSync(path.dirname(expectedIrPath), { recursive: true })
        fs.writeFileSync(expectedIrPath, actualIr)
        fs.writeFileSync(expectedDiagnosticsPath, actualDiagnostics)
        return
      }

      expect(fs.existsSync(expectedIrPath), `missing ${expectedIrPath} (run UPDATE_GOLDEN=1 pnpm test)`).toBe(true)
      expect(actualIr).toBe(fs.readFileSync(expectedIrPath, "utf8"))
      expect(actualDiagnostics).toBe(fs.readFileSync(expectedDiagnosticsPath, "utf8"))
    })
  }
})
