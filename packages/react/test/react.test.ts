import { describe, expect, it } from "vitest"
import { compile } from "@spec/compiler"
import { compareFrontendShots, planFrontendGeneration } from "../src"

describe("@spec/react frontend lowering", () => {
  it("derives a byte-stable blueprint, runtime, task, and Playwright oracle", async () => {
    const result = await compile("examples/frontend-golden/app.spec.ts", { projectRoot: process.cwd() })
    expect(result.ok).toBe(true)
    const first = planFrontendGeneration(result.ir)
    const second = planFrontendGeneration(result.ir)

    expect(first.stable).toBe(second.stable)
    expect(first.blueprint.screens.map((screen) => screen.path)).toEqual(["/", "/projects", "/reports"])
    expect(first.blueprint.components).toEqual(expect.arrayContaining(["appShell", "tabs", "form", "input", "select", "table"]))
    expect(first.dag.tasks.map((task) => task.id)).toEqual(["frontend"])
    expect(Object.keys(first.seedFiles).sort()).toEqual([
      ".gitignore",
      "src/frontend.blueprint.json",
      "src/spec-runtime.css",
      "src/spec-runtime.tsx",
      "tests/frontend.contract.test.mjs",
    ])
    expect(Object.keys(first.conformance.files).sort()).toEqual([
      "conformance/contract.json",
      "conformance/frontend.spec.ts",
      "conformance/playwright.config.ts",
    ])
    expect(first.seedFiles["src/spec-runtime.tsx"]).toContain("function SpecApp")
    // The frontend oracle is compiler-owned and frozen: it judges the node.
    expect(first.seedFiles["tests/frontend.contract.test.mjs"]).toContain("Compiler-owned frontend oracle")
    expect(first.seedFiles["tests/frontend.contract.test.mjs"]).toContain("node:test")
    const frontendTask = first.dag.tasks[0]
    expect(frontendTask.loop?.schemaVersion).toBe("spec-agent-task-loop/0.2")
    expect(frontendTask.loop?.tests).toBeUndefined()
    expect(frontendTask.loop?.reviewer.commands).toEqual(["node --test tests/frontend.contract.test.mjs"])
    expect(frontendTask.loop?.reviewer.oracleFiles).toEqual(["tests/frontend.contract.test.mjs"])
    expect(frontendTask.loop?.reviewer.clauses?.map((clause) => clause.id)).toContain("frontend:import:main-tsx")
    expect(frontendTask.scope).toEqual(["package.json", "index.html", "src/main.tsx"])
    expect(first.conformance.files["conformance/frontend.spec.ts"]).toContain("compiler-owned layout and behavior contract")
    // Golden-rule correctness clause: the oracle verifies every declared
    // screen and rejects navigation that no screen implements.
    expect(first.conformance.files["conformance/frontend.spec.ts"]).toContain("matches no declared screen path")
    expect(first.conformance.files["conformance/frontend.spec.ts"]).toContain('"layout-" + index + ".png"')
    // Shot workspaces sit under the repo's pnpm workspace; installs must be
    // workspace-independent or the shot manifest is never installed.
    expect(first.verification.setup.map((command) => command.command)).toEqual([
      "pnpm install --ignore-workspace --frozen-lockfile=false",
      "pnpm exec playwright install chromium",
    ])
  })

  it("rejects navigation that targets no declared screen at compile time", async () => {
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const source = fs.readFileSync("examples/frontend-golden/app.spec.ts", "utf8")
    const broken = source.replace('href: "/projects"', 'href: "/projekts"').replace('href: "/reports"', 'href: "/deep-reports"')
    const file = path.join("examples/frontend-golden", ".tmp-nav-defect.spec.ts")
    fs.writeFileSync(file, broken, "utf8")
    try {
      const result = await compile(file, { projectRoot: process.cwd() })
      expect(result.ok).toBe(false)
      const codes = result.diagnostics.filter((diagnostic) => diagnostic.level === "error").map((diagnostic) => diagnostic.code)
      expect(codes).toContain("UI_NAV_TARGET_UNKNOWN")
    } finally {
      fs.rmSync(file, { force: true })
    }
  })

  it("requires all visual and behavioral evidence for equality", () => {
    expect(compareFrontendShots([])).toMatchObject({ ok: false, layoutEqual: false, behaviorEqual: false })
  })
})
