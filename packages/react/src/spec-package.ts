import { defineGeneration, defineNode, definePackage, defineValidator, diag } from "@spec/package-sdk"
import type { Diagnostic, SpecNode } from "@spec/core"

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const validateReact = defineValidator("react/validate", (ctx) => {
  const diagnostics: Diagnostic[] = []
  for (const target of ctx.findNodes("react")) {
    const ref = object(target.attributes.frontend) && typeof target.attributes.frontend.nodeId === "string"
      ? target.attributes.frontend.nodeId
      : undefined
    const frontend = ref ? ctx.getNode(ref) : undefined
    if (!frontend || frontend.kind !== "frontend") {
      diagnostics.push(diag("REACT_FRONTEND_INVALID", "error", `React target must reference a frontend(...) node.`, { nodeId: target.id }))
    }
    const port = target.attributes.port
    if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) {
      diagnostics.push(diag("REACT_PORT_INVALID", "error", `React target port must be an integer from 1 to 65535.`, { nodeId: target.id }))
    }
  }
  if (ctx.findNodes("react").length > 1) {
    diagnostics.push(diag("REACT_TARGET_MULTIPLE", "error", `The first frontend target supports exactly one react(...) node.`, {}))
  }
  return diagnostics
})

export default definePackage({
  name: "@spec/react",
  version: "0.1.0",
  nodeKinds: [defineNode("react")],
  validators: [validateReact],
  inspectors: {
    react: (node: SpecNode) => ({
      label: node.name ?? "react",
      lines: [`frontend: ${JSON.stringify(node.attributes.frontend)}  port: ${String(node.attributes.port)}`],
    }),
  },
  generation: [
    defineGeneration({
      id: "react-vite-baseline",
      target: "react-vite",
      nodeKinds: ["react"],
      tasks: ["frontend"],
      instructions: [
        "Use the compiler-owned spec runtime and blueprint without reinterpreting component semantics.",
        "Do not add application state, styling, routes, content, or behavior outside the frontend blueprint.",
      ],
    }),
  ],
})
