/**
 * Golden-rule end-to-end test (opt-in — costs real agent tokens).
 *
 *   SPEC_AGENT_E2E=1 npx vitest run tests/generate.e2e.test.ts
 *
 * For each of the three anti-overfit test projects: generate N independent
 * shots, require every shot to pass the compiler's conformance suite, and
 * require all shots to expose an identical normalized OpenAPI interface.
 */
import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { compile } from "@spec/compiler"
import { implementPrompt, planGeneration, repairPrompt } from "@spec/fastapi"
import { runRepeatability, type ShotSpec } from "@spec/agent"

const E2E = process.env.SPEC_AGENT_E2E === "1"
const ROOT = path.resolve(__dirname, "..")
const PROJECTS = ["inventory", "cblog", "booking"] as const

describe("golden rule: generation is repeatable (E2E)", () => {
  for (const project of PROJECTS) {
    it.skipIf(!E2E)(`${project}: N shots conform and expose identical interfaces`, async () => {
      const result = await compile(`examples/${project}/app.spec.ts`, { projectRoot: ROOT })
      expect(result.ok).toBe(true)
      const plan = planGeneration(result.ir)

      const shotSpec: ShotSpec = {
        implementPrompt: implementPrompt(plan.blueprint),
        repairPrompt: (failure) => repairPrompt(plan.blueprint, failure),
        conformanceFiles: plan.conformance.files,
        conformanceDirs: ["conformance"],
        verification: plan.verification,
        specNodeIds: plan.tasks[0]?.context.specNodeIds ?? [],
      }

      const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), `spec-e2e-${project}-`))
      const shots = Array.from({ length: 2 }, (_, i) => ({
        shot: `shot-${i + 1}`,
        workspace: path.join(outRoot, `${i + 1}`),
      }))

      const report = await runRepeatability(shotSpec, shots, { model: "claude-sonnet-4-5" })

      expect(report.shots.map((s) => s.ok)).toEqual([true, true])
      expect(report.interfaceEqual).toBe(true)
      expect(report.ok).toBe(true)
    }, 60 * 60 * 1000)
  }
})
