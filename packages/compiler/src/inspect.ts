/**
 * `spec inspect` rendering.
 *
 * Rendering is domain-agnostic: packages may register per-node-kind
 * inspectors (see SpecPackage.inspectors) so that e.g. @spec/web decides
 * how an entity is displayed. The compiler falls back to a generic
 * attribute dump for nodes without an inspector.
 */
import type { NodeInspector, SpecIR, SpecNode } from "@spec/core"
import type { LoadedSpecPackage } from "./loader"

export function renderSpecTree(ir: SpecIR, packages: LoadedSpecPackage[]): string {
  const inspectors = new Map<string, NodeInspector>()
  for (const pkg of packages) {
    for (const [kind, inspector] of Object.entries(pkg.definition.inspectors ?? {})) {
      inspectors.set(`${pkg.name}:${kind}`, inspector)
    }
  }

  const app = ir.nodes.find((node) => node.kind === "app")
  const byName = new Map<string, SpecNode>()
  for (const node of ir.nodes) {
    if (node.name) byName.set(node.name, node)
  }

  const out: string[] = [`Application ${app?.name ?? ir.app.name}`, ""]

  for (const section of ["entities", "services", "resources"]) {
    const names = app?.attributes[section]
    if (!Array.isArray(names) || names.length === 0) continue
    const nodes = names
      .map((name) => byName.get(String(name)))
      .filter((node): node is SpecNode => node !== undefined)
    if (nodes.length === 0) continue
    out.push(capitalize(section))
    out.push(...block(nodes.map((node) => renderNode(node, inspectors))))
    out.push("")
  }

  return out.join("\n").trimEnd() + "\n"
}

function renderNode(node: SpecNode, inspectors: Map<string, NodeInspector>): string[] {
  const inspector = inspectors.get(`${node.package}:${node.kind}`)
  let label: string
  let lines: string[]
  if (inspector) {
    const rendered = inspector(node)
    label = rendered.label
    lines = rendered.lines
  } else {
    label = node.name ?? node.kind
    lines = genericLines(node)
  }
  const entries: string[][] = [
    ...lines.map((line) => [line]),
    ...(node.children ?? []).map((child) => renderNode(child, inspectors)),
  ]
  return [label, ...block(entries)]
}

function genericLines(node: SpecNode): string[] {
  const skip = new Set(["entities", "services", "resources", "provides", "requires"])
  return Object.keys(node.attributes)
    .filter((key) => !skip.has(key))
    .sort()
    .map((key) => `${key}: ${JSON.stringify(node.attributes[key])}`)
}

function block(entries: string[][]): string[] {
  const out: string[] = []
  entries.forEach((entryLines, index) => {
    const isLast = index === entries.length - 1
    entryLines.forEach((line, lineIndex) => {
      if (lineIndex === 0) {
        out.push((isLast ? "└── " : "├── ") + line)
      } else {
        out.push((isLast ? "    " : "│   ") + line)
      }
    })
  })
  return out
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1)
}
