import { defineNode, definePackage } from "@spec/package-sdk"
import type { SpecNode } from "@spec/core"
import { validateUi } from "./validators"

export default definePackage({
  name: "@spec/ui",
  version: "0.1.0",
  nodeKinds: [defineNode("screen"), defineNode("frontend")],
  validators: [validateUi],
  inspectors: {
    screen: (node: SpecNode) => ({
      label: node.name ?? "screen",
      lines: [`${String(node.attributes.path)} — ${String(node.attributes.title)}`],
    }),
    frontend: (node: SpecNode) => ({
      label: node.name ?? "frontend",
      lines: [`title: ${String(node.attributes.title)}`],
    }),
  },
})
