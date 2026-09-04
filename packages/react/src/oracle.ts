/**
 * Compiler-generated frontend oracle.
 *
 * The frontend's single generation node is judged by a compiler-owned
 * node:test file (same clause-table projection as the backend oracles):
 * pins, file shapes, the exact import set of src/main.tsx, and the
 * blueprint's screen path uniqueness. Frozen from round 1, unwritable by
 * any agent, identical in every shot.
 */
import { stableStringify } from "@spec/core"
import type { FrontendBlueprint } from "./blueprint"

export const FRONTEND_ORACLE_FILE = "tests/frontend.contract.test.mjs"

export function frontendOracleFile(blueprint: FrontendBlueprint): string {
  const contract = {
    node: "frontend",
    kind: "frontend",
    app: {
      name: blueprint.app.name.toLowerCase().replace(/[^a-z0-9-]/g, "-") + "-frontend",
      title: blueprint.app.title,
    },
    stack: {
      react: blueprint.stack.react,
      reactDom: blueprint.stack.reactDom,
      playwright: blueprint.stack.playwright,
      typesReact: blueprint.stack.typesReact,
      typesReactDom: blueprint.stack.typesReactDom,
      typescript: blueprint.stack.typescript,
      vite: blueprint.stack.vite,
    },
    screens: blueprint.screens.map((screen) => ({ name: screen.name, path: screen.path })).sort((left, right) => left.name.localeCompare(right.name)),
  }
  return `// Compiler-owned frontend oracle — DO NOT EDIT (generated from the clause table).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const CONTRACT = JSON.parse(${JSON.stringify(stableStringify(contract))})

test("package.json pins the declared stack", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"))
  assert.equal(pkg.name, CONTRACT.app.name)
  assert.equal(pkg.private, true)
  assert.equal(pkg.type, "module")
  assert.deepEqual(pkg.dependencies, { react: CONTRACT.stack.react, "react-dom": CONTRACT.stack.reactDom })
  assert.equal(pkg.devDependencies["@playwright/test"], CONTRACT.stack.playwright)
  assert.equal(pkg.devDependencies.vite, CONTRACT.stack.vite)
})

test("index.html mounts exactly one root and one module script", () => {
  const html = readFileSync("index.html", "utf8")
  assert.match(html, /<html[^>]*lang="en"/)
  assert.equal((html.match(/<div[^>]*id="root"/g) ?? []).length, 1)
  assert.equal((html.match(/<script[^>]*type="module"[^>]*src="\/src\/main\.tsx"/g) ?? []).length, 1)
  const title = html.match(/<title>([^<]*)<\/title>/)
  assert.equal(title?.[1], CONTRACT.app.title)
})

test("src/main.tsx wires the compiler-owned runtime exactly", () => {
  const source = readFileSync("src/main.tsx", "utf8")
  assert.match(source, /import\s+React\s+from\s+"react"/)
  assert.match(source, /import\s+\w+\s+from\s+"react-dom\/client"/)
  assert.match(source, /import\s+\w+\s+from\s+"\.\/frontend\.blueprint\.json"/)
  assert.match(source, /import\s+\{\s*SpecApp\s*\}\s+from\s+"\.\/spec-runtime"/)
  assert.match(source, /import\s+"\.\/spec-runtime\.css"/)
  assert.match(source, /getElementById\("root"\)/)
  assert.match(source, /StrictMode/)
})

test("blueprint screen paths are unique (wired by the compiler-owned runtime)", () => {
  const paths = CONTRACT.screens.map((screen) => screen.path)
  assert.equal(new Set(paths).size, paths.length)
})
`
}
