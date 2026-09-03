import { stableStringify, type AgentExecutionLoop, type SpecIR } from "@spec/core"
import type { FrontendBlueprint } from "./blueprint"

export interface FrontendTask {
  id: string
  kind: string
  label: string
  dependsOn: string[]
  scope: string[]
  prompt: string
  specNodeIds: string[]
  loop?: AgentExecutionLoop
  acceptanceCommands?: string[]
}

export interface FrontendDag {
  blueprint: FrontendBlueprint
  tasks: FrontendTask[]
  edges: Array<{ from: string; to: string }>
}

export function buildFrontendDag(blueprint: FrontendBlueprint, ir: SpecIR): FrontendDag {
  const packageJson = {
    name: blueprint.app.name.toLowerCase().replace(/[^a-z0-9-]/g, "-") + "-frontend",
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    dependencies: { react: blueprint.stack.react, "react-dom": blueprint.stack.reactDom },
    devDependencies: {
      "@playwright/test": blueprint.stack.playwright,
      "@types/react": blueprint.stack.typesReact,
      "@types/react-dom": blueprint.stack.typesReactDom,
      typescript: blueprint.stack.typescript,
      vite: blueprint.stack.vite,
    },
  }
  const prompt = `You are implementing the integration shell for a compiler-specified React frontend.

The compiler has already written these IMMUTABLE files. Read and import them; never modify them:
- src/frontend.blueprint.json
- src/spec-runtime.tsx
- src/spec-runtime.css

Create EXACTLY these three files and no others:
- package.json
- index.html
- src/main.tsx

package.json must equal this JSON semantically:
${stableStringify(packageJson)}

index.html contract:
- normal HTML5 document, lang="en"
- title exactly ${JSON.stringify(blueprint.app.title)}
- one <div id="root"></div>
- one module script loading /src/main.tsx

src/main.tsx contract:
- import React from "react"
- import createRoot from react-dom/client
- import blueprint from "./frontend.blueprint.json"
- import SpecApp from the named export in "./spec-runtime"
- import "./spec-runtime.css"
- require #root to exist, then render <React.StrictMode><SpecApp blueprint={blueprint} /></React.StrictMode>

Do not reinterpret the blueprint. Do not add CSS, components, content, state, routes, packages, tests, configuration, or behavior. Do not modify compiler-owned files. This task is wiring only.`
  return {
    blueprint,
    tasks: [{
      id: "frontend",
      kind: "frontend",
      label: "React frontend integration shell",
      dependsOn: [],
      scope: ["package.json", "index.html", "src/main.tsx", "tests/frontend.contract.test.mjs"],
      prompt,
      specNodeIds: ir.nodes.map((node) => node.id).filter((id) => /^(app|frontend|screen|react):/.test(id)).sort(),
      loop: {
        schemaVersion: "spec-agent-task-loop/0.1",
        maxRounds: 3,
        implementation: {
          instruction: prompt,
          scope: ["package.json", "index.html", "src/main.tsx"],
        },
        tests: {
          scope: ["tests/frontend.contract.test.mjs"],
          instruction: `You are the unit-test author for the frozen React integration-shell contract below. Create tests/frontend.contract.test.mjs using only node:test and node:assert. Inspect the generated files as text/JSON and verify every declared import, mount, package pin, and forbidden extra. Do not edit implementation or compiler-owned files.\n\n${prompt}`,
        },
        reviewer: {
          instruction: "Review the React shell and its tests against the frozen blueprint. Run the declared test command, inspect for missing constraints or implementation-shaped tests, and return actionable feedback without editing files.",
          commands: ["node --test tests/frontend.contract.test.mjs"],
        },
      },
      acceptanceCommands: ["node --test tests/frontend.contract.test.mjs"],
    }],
    edges: [],
  }
}
