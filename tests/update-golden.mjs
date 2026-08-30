/**
 * Regenerate golden expectations:
 *   pnpm build && node tests/update-golden.mjs
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { compile, stableStringify } from "@spec/compiler"

const projectRoot = path.resolve(process.cwd())
const fixturesRoot = path.join(projectRoot, "tests", "fixtures")

for (const name of fs.readdirSync(fixturesRoot)) {
  const entry = path.join("tests", "fixtures", name, "app.spec.ts")
  if (!fs.existsSync(path.join(projectRoot, entry))) continue
  const result = await compile(entry, { projectRoot })
  const outDir = path.join(fixturesRoot, name, "expected")
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, "ir.json"), stableStringify(result.ir) + "\n")
  fs.writeFileSync(
    path.join(outDir, "diagnostics.json"),
    stableStringify(result.diagnostics) + "\n",
  )
  console.log(`✓ ${name}: ${result.ok ? "valid" : "invalid"} (${result.diagnostics.length} diagnostics)`)
}
