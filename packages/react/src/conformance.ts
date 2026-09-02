import { stableStringify } from "@spec/core"
import type { FrontendBlueprint } from "./blueprint"

export interface FrontendConformanceFiles {
  files: Record<string, string>
}

function playwrightConfig(bp: FrontendBlueprint): string {
  return `import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "frontend.spec.ts",
  workers: 1,
  fullyParallel: false,
  reporter: "line",
  outputDir: "../conformance-output/test-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:${bp.app.port}",
    viewport: { width: ${bp.contract.viewport.width}, height: ${bp.contract.viewport.height} },
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    screenshot: "off",
    trace: "off",
  },
  webServer: {
    command: "pnpm dev --host 127.0.0.1 --port ${bp.app.port}",
    url: "http://127.0.0.1:${bp.app.port}",
    reuseExistingServer: false,
    timeout: 120000,
    stdout: "pipe",
    stderr: "pipe",
  },
})
`
}

const TEST_SOURCE = String.raw`import { expect, test } from "@playwright/test"
import fs from "node:fs"
import path from "node:path"

const blueprint = JSON.parse(fs.readFileSync(path.resolve("conformance/contract.json"), "utf8"))

type RecordValue = Record<string, any>

function components(value: any, kind?: string, out: RecordValue[] = []): RecordValue[] {
  if (Array.isArray(value)) {
    value.forEach((item) => components(item, kind, out))
    return out
  }
  if (!value || typeof value !== "object") return out
  if (value.__uiComponent === true && (!kind || value.kind === kind)) out.push(value)
  Object.values(value).forEach((item) => components(item, kind, out))
  return out
}

function actions(value: any, kind?: string, out: RecordValue[] = []): RecordValue[] {
  if (Array.isArray(value)) {
    value.forEach((item) => actions(item, kind, out))
    return out
  }
  if (!value || typeof value !== "object") return out
  if (value.__uiAction === true && (!kind || value.kind === kind)) out.push(value)
  Object.values(value).forEach((item) => actions(item, kind, out))
  return out
}

function box(value: { x: number; y: number; width: number; height: number } | null) {
  if (!value) return null
  return Object.fromEntries(Object.entries(value).map(([key, number]) => [key, Math.round(number)]))
}

test("compiler-owned layout and behavior contract", async ({ page }) => {
  const output = path.resolve("conformance-output")
  fs.mkdirSync(output, { recursive: true })
  const screens = blueprint.screens
  if (!Array.isArray(screens) || screens.length === 0) throw new Error("Blueprint must declare at least one screen")

  /* Golden rule (correctness clause): declared navigation must resolve to a
   * real screen. Two shots can be identically wrong — dead links fail here
   * even when every shot renders them identically. */
  for (const screen of screens) {
    for (const item of (screen.body && screen.body.props && screen.body.props.navigation) || []) {
      if (!screens.some((candidate) => candidate.path === item.href)) {
        throw new Error("Dead navigation on screen \"" + screen.name + "\": \"" + item.label + "\" -> \"" + item.href + "\" matches no declared screen path")
      }
    }
  }

  const checkShell = async (screen: RecordValue) => {
    await expect(page).toHaveTitle(blueprint.app.title)
    await expect(page.locator("[data-screen]")).toHaveAttribute("data-screen", screen.name)
    await expect(page.getByRole("heading", { name: screen.title })).toBeVisible()
    const sidebar = page.locator('[data-component="sidebar"]')
    const main = page.locator('[data-component="main"]')
    await expect(sidebar).toBeVisible()
    await expect(main).toBeVisible()
    const sidebarBox = await sidebar.boundingBox()
    const mainBox = await main.boundingBox()
    expect(Math.round(sidebarBox?.width || 0)).toBe(blueprint.contract.layout.sidebarWidth)
    expect(Math.round(mainBox?.x || 0)).toBe(blueprint.contract.layout.sidebarWidth)
    expect(Math.round(mainBox?.width || 0)).toBe(blueprint.contract.viewport.width - blueprint.contract.layout.sidebarWidth)
    expect(await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(244, 246, 251)")
    expect(await sidebar.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(23, 37, 84)")
    const allKinds = await page.locator("[data-component]").evaluateAll((nodes) => [...new Set(nodes.map((node) => node.getAttribute("data-component")))].filter(Boolean).sort())
    for (const visibleKind of allKinds) expect(blueprint.components).toContain(visibleKind === "sidebar" || visibleKind === "main" ? "appShell" : visibleKind)
  }

  /* 1 — every declared screen renders its own layout, pixel-captured. */
  for (let index = 0; index < screens.length; index++) {
    const screen = screens[index]
    await page.goto(screen.path)
    await checkShell(screen)
    await page.screenshot({ path: path.join(output, "layout-" + index + ".png"), fullPage: true, animations: "disabled" })
  }

  /* 2 — navigation click-through: every nav item must land on its screen. */
  const home = screens[0]
  const navigationChecks: Array<Record<string, string>> = []
  for (const item of (home.body.props.navigation || [])) {
    await page.goto(home.path)
    await page.locator('[data-component="sidebar"]').getByRole("link", { name: item.label, exact: true }).click()
    const target = screens.find((candidate) => candidate.path === item.href)
    await expect(page.locator("[data-screen]")).toHaveAttribute("data-screen", target.name)
    await expect(page.getByRole("heading", { name: target.title })).toBeVisible()
    navigationChecks.push({ label: item.label, href: item.href, landedOn: target.name })
  }

  /* 3 — the interaction contract runs on the screen that owns the form. */
  const screen = screens.find((candidate) => components(candidate.body, "form").length > 0)
  if (!screen) throw new Error("Conformance fixture requires one screen with a form")
  await page.goto(screen.path)
  const sidebar = page.locator('[data-component="sidebar"]')
  const main = page.locator('[data-component="main"]')
  const form = components(screen.body, "form")[0]
  const formTab = components(screen.body, "tab").find((tab) => components(tab.props.content, "form").length > 0)
  const append = actions(form, "append")[0]
  const notify = actions(form, "notify")[0]
  const selectTab = actions(form, "selectTab")[0]
  if (!form || !formTab || !append) throw new Error("Conformance fixture requires a form inside a tab with an append action")

  await page.getByRole("tab", { name: formTab.props.label }).click()
  await expect(page.locator("#" + form.props.id)).toBeVisible()
  for (const field of form.props.fields) {
    if (field.kind === "input") {
      const input = page.getByLabel(field.props.label, { exact: false })
      await input.fill(field.props.type === "number" ? "7" : "Atlas launch")
    } else if (field.kind === "select") {
      const options = field.props.options || []
      await page.getByLabel(field.props.label, { exact: false }).selectOption(options[options.length - 1].value)
    }
  }

  const initialCollection = screen.state.find((item: RecordValue) => item.kind === "collection" && item.name === append.collection)
  const expectedCount = (initialCollection?.initial?.length || 0) + 1
  await page.getByRole("button", { name: form.props.submit.label }).click()

  if (notify) await expect(page.getByRole("status")).toHaveText(notify.message)
  if (selectTab) {
    const selectedTabs = components(screen.body, "tabs").find((tab) => tab.props.id === selectTab.target)
    const selected = selectedTabs?.props.items.find((tab: RecordValue) => tab.props.value === selectTab.value)
    if (selected) await expect(page.getByRole("tab", { name: selected.props.label })).toHaveAttribute("aria-selected", "true")
  }
  for (const outputField of Object.keys(append.fields || {})) {
    const inputId = append.fields[outputField]
    const field = form.props.fields.find((item: RecordValue) => item.props.id === inputId)
    const expected = field.kind === "select" ? field.props.options[field.props.options.length - 1].label : field.props.type === "number" ? "7" : "Atlas launch"
    await expect(page.getByRole("cell", { name: expected, exact: true }).last()).toBeVisible()
  }
  await expect(page.locator('[data-component="stat"] .spec-stat-value').filter({ hasText: String(expectedCount) })).toHaveCount(1)

  await page.screenshot({ path: path.join(output, "behavior.png"), fullPage: true, animations: "disabled" })
  const snapshot = {
    screen: screen.name,
    title: await page.title(),
    screens: screens.map((item: RecordValue) => ({ name: item.name, path: item.path, title: item.title })),
    navigation: navigationChecks,
    selectedTabs: await page.getByRole("tab", { selected: true }).allTextContents(),
    alerts: await page.getByRole("status").allTextContents(),
    rows: await page.getByRole("row").allTextContents(),
    componentCounts: await page.locator("[data-component]").evaluateAll((nodes) => nodes.reduce((out: Record<string, number>, node) => {
      const kind = node.getAttribute("data-component") || "unknown"
      out[kind] = (out[kind] || 0) + 1
      return out
    }, {})),
    layout: { sidebar: box(await sidebar.boundingBox()), main: box(await main.boundingBox()) },
    colors: {
      body: await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor),
      sidebar: await sidebar.evaluate((node) => getComputedStyle(node).backgroundColor),
    },
  }
  fs.writeFileSync(path.join(output, "behavior.json"), JSON.stringify(snapshot, null, 2) + "\n")
})
`

export function buildFrontendConformanceSuite(bp: FrontendBlueprint): FrontendConformanceFiles {
  return {
    files: {
      "conformance/contract.json": stableStringify(bp) + "\n",
      "conformance/playwright.config.ts": playwrightConfig(bp),
      "conformance/frontend.spec.ts": TEST_SOURCE,
    },
  }
}
