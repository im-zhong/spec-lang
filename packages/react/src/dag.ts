import { stableStringify, type AgentExecutionLoop, type ContractClause, type SpecIR } from "@spec/core"
import type { FrontendBlueprint } from "./blueprint"
import { FRONTEND_ORACLE_FILE } from "./oracle"

export interface FrontendTask {
  id: string
  kind: string
  label: string
  dependsOn: string[]
  scope: string[]
  prompt: string
  /** The node's machine-addressable contract (see the oracle projection). */
  clauses: ContractClause[]
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
  const clauses: ContractClause[] = [
    { id: "frontend:pin:package-name", statement: `package.json declares name ${JSON.stringify(packageJson.name)}, private true, type module, and exactly the scripts dev/build/preview.`, node: "frontend", kind: "pin", verification: "oracle", level: "api" },
    { id: "frontend:pin:dependencies", statement: `package.json dependencies are exactly react@${blueprint.stack.react} and react-dom@${blueprint.stack.reactDom}; devDependencies carry the pinned Playwright/TypeScript/Vite toolchain.`, node: "frontend", kind: "pin", verification: "oracle", level: "api" },
    { id: "frontend:file:index-html", statement: `index.html is an HTML5 document with lang="en", title exactly ${JSON.stringify(blueprint.app.title)}, exactly one <div id="root">, and exactly one module script loading /src/main.tsx.`, node: "frontend", kind: "file", verification: "oracle", level: "api" },
    { id: "frontend:import:main-tsx", statement: 'src/main.tsx imports React from react, a createRoot binding from react-dom/client, the blueprint from ./frontend.blueprint.json, the named SpecApp export from ./spec-runtime, and ./spec-runtime.css; it mounts <React.StrictMode><SpecApp blueprint={blueprint} /></React.StrictMode> into #root.', node: "frontend", kind: "import", verification: "oracle", level: "api" },
    { id: "frontend:file:exact-set", statement: "The implementation owns exactly package.json, index.html, and src/main.tsx — no CSS, components, state, routes, packages, or configuration beyond them.", node: "frontend", kind: "file", verification: "review", level: "api" },
    { id: "frontend:runtime-untouched", statement: "The compiler-owned files src/frontend.blueprint.json, src/spec-runtime.tsx, and src/spec-runtime.css are imported, never modified.", node: "frontend", kind: "file", verification: "review", level: "api" },
  ]
  const clauseTable = clauses.map((clause) => `- [${clause.id}]${clause.verification === "review" ? " (reviewer-judged)" : ""} ${clause.statement}`).join("\n")
  const prompt = `You are implementing the integration shell for a compiler-specified React frontend.

The compiler has already written these IMMUTABLE files. Read and import them; never modify them:
- src/frontend.blueprint.json
- src/spec-runtime.tsx
- src/spec-runtime.css

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written.

${clauseTable}

## Reference data (subordinate to the clause table)

package.json must equal this JSON semantically:
${stableStringify(packageJson)}

## Engineering notes
- Do not reinterpret the blueprint. This task is wiring only.
- If you conclude this contract is internally unsatisfiable or wrong, make no
  edits and reply with exactly one JSON object and nothing else:
  {"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
  Never improvise around a defect; challenging it is the only correct response.`
  const oracleCommand = `node --test ${FRONTEND_ORACLE_FILE}`
  return {
    blueprint,
    tasks: [{
      id: "frontend",
      kind: "frontend",
      label: "React frontend integration shell",
      dependsOn: [],
      scope: ["package.json", "index.html", "src/main.tsx"],
      prompt,
      clauses,
      specNodeIds: ir.nodes.map((node) => node.id).filter((id) => /^(app|frontend|screen|react):/.test(id)).sort(),
      loop: {
        schemaVersion: "spec-agent-task-loop/0.2",
        maxRounds: 3,
        implementation: {
          instruction: prompt,
          scope: ["package.json", "index.html", "src/main.tsx"],
        },
        reviewer: {
          instruction: "Review the React shell against the frozen clause table. The machine evidence comes from the compiler-owned oracle; confirm the implementation does not game it, and judge the review-kind clauses (exact file set, untouched compiler-owned runtime) by inspection. Do not edit any file. Your result must be exactly one JSON object: {\"approved\":boolean,\"feedback\":\"specific changes keyed to clause ids\"}.",
          commands: [oracleCommand],
          oracleFiles: [FRONTEND_ORACLE_FILE],
          clauses,
        },
      },
      acceptanceCommands: [oracleCommand],
    }],
    edges: [],
  }
}
