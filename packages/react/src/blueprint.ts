import type { SpecIR, SpecNode } from "@spec/core"

export interface ReactStack {
  react: string
  reactDom: string
  vite: string
  typescript: string
  playwright: string
  typesReact: string
  typesReactDom: string
}

export interface FrontendScreenBlueprint {
  id: string
  name: string
  path: string
  title: string
  state: unknown[]
  body: unknown
}

export interface FrontendBlueprint {
  version: "frontend-blueprint/0.1"
  app: { name: string; title: string; port: number }
  theme: { accent: string; density: string; radius: string }
  screens: FrontendScreenBlueprint[]
  components: string[]
  stack: ReactStack
  contract: {
    rendering: "compiler-owned-component-runtime"
    routing: "pathname"
    state: "screen-local"
    viewport: { width: 1440; height: 900 }
    layout: { sidebarWidth: 264; contentMaxWidth: 1120; contentPadding: 48 }
    behavior: {
      tabs: "single-active-aria"
      forms: "native-validation-declarative-actions"
      appendIds: "collection-length-plus-one"
      actionOrder: "declared"
    }
  }
}

const DEFAULT_STACK: ReactStack = {
  react: "19.2.8",
  reactDom: "19.2.8",
  vite: "8.2.2",
  typescript: "7.0.2",
  playwright: "1.62.1",
  typesReact: "19.2.18",
  typesReactDom: "19.2.5",
}

function flatten(nodes: readonly SpecNode[]): SpecNode[] {
  const out: SpecNode[] = []
  const visit = (node: SpecNode) => {
    out.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  nodes.forEach(visit)
  return out
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function collectComponents(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectComponents(item, out))
    return out
  }
  if (!object(value)) return out
  if (value.__uiComponent === true && typeof value.kind === "string") out.add(value.kind)
  Object.values(value).forEach((item) => collectComponents(item, out))
  return out
}

export function buildFrontendBlueprint(ir: SpecIR): FrontendBlueprint {
  const all = flatten(ir.nodes)
  const byId = new Map(all.map((node) => [node.id, node]))
  const target = all.find((node) => node.kind === "react")
  if (!target) throw new Error("No react(...) target exists in the specification")
  const frontendId = object(target.attributes.frontend) && typeof target.attributes.frontend.nodeId === "string"
    ? target.attributes.frontend.nodeId
    : undefined
  const frontend = frontendId ? byId.get(frontendId) : undefined
  if (!frontend) throw new Error("React target references no frontend node")
  const screenRefs = Array.isArray(frontend.attributes.screens) ? frontend.attributes.screens : []
  const screens: FrontendScreenBlueprint[] = screenRefs.map((ref) => {
    const id = object(ref) && typeof ref.nodeId === "string" ? ref.nodeId : ""
    const node = byId.get(id)
    if (!node) throw new Error(`Frontend references missing screen ${id}`)
    return {
      id: node.id,
      name: node.name ?? node.id,
      path: String(node.attributes.path),
      title: String(node.attributes.title),
      state: Array.isArray(node.attributes.state) ? node.attributes.state : [],
      body: node.attributes.body,
    }
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.name.localeCompare(right.name))
  const theme = object(frontend.attributes.theme) ? frontend.attributes.theme : {}
  const override = object(target.attributes.stack) ? target.attributes.stack : {}
  const stack: ReactStack = {
    react: typeof override.react === "string" ? override.react : DEFAULT_STACK.react,
    reactDom: typeof override.reactDom === "string" ? override.reactDom : DEFAULT_STACK.reactDom,
    vite: typeof override.vite === "string" ? override.vite : DEFAULT_STACK.vite,
    typescript: typeof override.typescript === "string" ? override.typescript : DEFAULT_STACK.typescript,
    playwright: typeof override.playwright === "string" ? override.playwright : DEFAULT_STACK.playwright,
    typesReact: DEFAULT_STACK.typesReact,
    typesReactDom: DEFAULT_STACK.typesReactDom,
  }
  return {
    version: "frontend-blueprint/0.1",
    app: {
      name: ir.app.name,
      title: String(frontend.attributes.title),
      port: Number(target.attributes.port ?? 4173),
    },
    theme: {
      accent: String(theme.accent ?? "indigo"),
      density: String(theme.density ?? "comfortable"),
      radius: String(theme.radius ?? "medium"),
    },
    screens,
    components: [...collectComponents(screens)].sort(),
    stack,
    contract: {
      rendering: "compiler-owned-component-runtime",
      routing: "pathname",
      state: "screen-local",
      viewport: { width: 1440, height: 900 },
      layout: { sidebarWidth: 264, contentMaxWidth: 1120, contentPadding: 48 },
      behavior: {
        tabs: "single-active-aria",
        forms: "native-validation-declarative-actions",
        appendIds: "collection-length-plus-one",
        actionOrder: "declared",
      },
    },
  }
}
