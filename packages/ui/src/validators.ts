import type { Diagnostic, SpecNode } from "@spec/core"
import { defineValidator, diag } from "@spec/package-sdk"

const COMPONENTS = new Set([
  "appShell", "stack", "grid", "card", "heading", "text", "stat",
  "tabs", "tab", "form", "input", "select", "table", "alert",
])
const CHILD_KEYS: Record<string, string[]> = {
  appShell: ["content"], stack: ["children"], grid: ["children"], card: ["children"],
  tabs: ["items"], tab: ["content"], form: ["fields"],
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function refId(value: unknown): string | undefined {
  return object(value) && typeof value.nodeId === "string" ? value.nodeId : undefined
}

interface WalkState {
  ids: Set<string>
  tabs: Map<string, Set<string>>
  forms: Set<string>
  collections: Set<string>
  alerts: Set<string>
  actions: Array<Record<string, unknown>>
  navs: Array<{ screen: SpecNode; label: string; href: string }>
  diagnostics: Diagnostic[]
  screen: SpecNode
}

function walkAction(value: unknown, state: WalkState): void {
  if (!object(value) || value.__uiAction !== true || typeof value.kind !== "string") return
  state.actions.push(value)
  if (value.kind === "sequence" && Array.isArray(value.actions)) {
    value.actions.forEach((item) => walkAction(item, state))
  }
}

function walkComponent(value: unknown, state: WalkState): void {
  if (!object(value) || value.__uiComponent !== true || typeof value.kind !== "string") {
    state.diagnostics.push(diag("UI_COMPONENT_INVALID", "error", `Screen "${state.screen.name}" contains a value that is not a ui component.`, { nodeId: state.screen.id }))
    return
  }
  if (!COMPONENTS.has(value.kind)) {
    state.diagnostics.push(diag("UI_COMPONENT_UNKNOWN", "error", `Unknown UI component "${value.kind}".`, { nodeId: state.screen.id, details: { component: value.kind } }))
    return
  }
  const props = object(value.props) ? value.props : {}
  if (typeof props.id === "string") {
    if (state.ids.has(props.id)) {
      state.diagnostics.push(diag("UI_ID_DUPLICATE", "error", `Duplicate UI id "${props.id}" in screen "${state.screen.name}".`, { nodeId: state.screen.id }))
    }
    state.ids.add(props.id)
  }
  if (value.kind === "tabs" && typeof props.id === "string") {
    const values = new Set<string>()
    for (const item of Array.isArray(props.items) ? props.items : []) {
      if (object(item) && object(item.props) && typeof item.props.value === "string") values.add(item.props.value)
    }
    state.tabs.set(props.id, values)
    if (typeof props.defaultValue !== "string" || !values.has(props.defaultValue)) {
      state.diagnostics.push(diag("UI_TABS_DEFAULT_UNKNOWN", "error", `Tabs "${props.id}" defaultValue must name one of its tabs.`, { nodeId: state.screen.id }))
    }
  }
  if (value.kind === "form" && typeof props.id === "string") {
    state.forms.add(props.id)
    if (object(props.submit)) walkAction(props.submit.action, state)
  }
  if (value.kind === "table" && typeof props.source === "string" && !state.collections.has(props.source)) {
    state.diagnostics.push(diag("UI_STATE_SOURCE_UNKNOWN", "error", `Table references unknown collection state "${props.source}".`, { nodeId: state.screen.id }))
  }
  if (value.kind === "alert" && typeof props.id === "string") state.alerts.add(props.id)
  if (value.kind === "appShell" && Array.isArray(props.navigation)) {
    for (const item of props.navigation) {
      if (object(item) && typeof item.href === "string") {
        state.navs.push({ screen: state.screen, label: String(item.label ?? item.href), href: item.href })
      }
    }
  }
  for (const key of CHILD_KEYS[value.kind] ?? []) {
    const child = props[key]
    if (Array.isArray(child)) child.forEach((item) => walkComponent(item, state))
    else if (child !== undefined) walkComponent(child, state)
  }
}

export const validateUi = defineValidator("ui/validate", (ctx) => {
  const diagnostics: Diagnostic[] = []
  const paths = new Map<string, string>()
  /** Navigation declared by appShells, checked once every screen path is known. */
  const navItems: Array<{ screen: SpecNode; label: string; href: string }> = []

  for (const screen of ctx.findNodes("screen")) {
    const path = screen.attributes.path
    if (typeof path !== "string" || !path.startsWith("/")) {
      diagnostics.push(diag("UI_SCREEN_PATH_INVALID", "error", `Screen "${screen.name}" path must start with "/".`, { nodeId: screen.id }))
    } else if (paths.has(path)) {
      diagnostics.push(diag("UI_SCREEN_PATH_DUPLICATE", "error", `Screens "${paths.get(path)}" and "${screen.name}" share route "${path}".`, { nodeId: screen.id }))
    } else paths.set(path, screen.name ?? screen.id)

    const stateItems = Array.isArray(screen.attributes.state) ? screen.attributes.state : []
    const collections = new Set<string>()
    for (const item of stateItems) {
      if (!object(item) || item.__uiState !== true || typeof item.name !== "string") {
        diagnostics.push(diag("UI_STATE_INVALID", "error", `Screen "${screen.name}" has an invalid state declaration.`, { nodeId: screen.id }))
        continue
      }
      if (collections.has(item.name)) diagnostics.push(diag("UI_STATE_DUPLICATE", "error", `Duplicate state "${item.name}".`, { nodeId: screen.id }))
      if (item.kind === "collection") collections.add(item.name)
    }
    const walk: WalkState = { ids: new Set(), tabs: new Map(), forms: new Set(), collections, alerts: new Set(), actions: [], navs: navItems, diagnostics, screen }
    walkComponent(screen.attributes.body, walk)

    for (const action of walk.actions) {
      if (action.kind === "append" && (typeof action.collection !== "string" || !walk.collections.has(action.collection))) {
        diagnostics.push(diag("UI_ACTION_COLLECTION_UNKNOWN", "error", `Append action references unknown collection "${String(action.collection)}".`, { nodeId: screen.id }))
      }
      if ((action.kind === "append" || action.kind === "resetForm") && typeof (action.fromForm ?? action.target) === "string") {
        const form = String(action.fromForm ?? action.target)
        if (!walk.forms.has(form)) diagnostics.push(diag("UI_ACTION_FORM_UNKNOWN", "error", `Action references unknown form "${form}".`, { nodeId: screen.id }))
      }
      if (action.kind === "selectTab") {
        const values = typeof action.target === "string" ? walk.tabs.get(action.target) : undefined
        if (!values || typeof action.value !== "string" || !values.has(action.value)) diagnostics.push(diag("UI_ACTION_TAB_UNKNOWN", "error", `selectTab action references an unknown tabs id or value.`, { nodeId: screen.id }))
      }
      if (action.kind === "notify" && (typeof action.target !== "string" || !walk.alerts.has(action.target))) {
        diagnostics.push(diag("UI_ACTION_ALERT_UNKNOWN", "error", `notify action references unknown alert "${String(action.target)}".`, { nodeId: screen.id }))
      }
    }
  }

  /* Golden rule: navigation that no screen implements is a specification
   * defect (both shots would be identically wrong). Reject it at compile
   * time instead of shipping dead links. */
  for (const nav of navItems) {
    if (!paths.has(nav.href)) {
      diagnostics.push(
        diag("UI_NAV_TARGET_UNKNOWN", "error", `Navigation "${nav.label}" on screen "${nav.screen.name}" targets "${nav.href}", which is not a declared screen path.`, { nodeId: nav.screen.id }),
      )
    }
  }

  for (const app of ctx.findNodes("frontend")) {
    const screens = app.attributes.screens
    if (!Array.isArray(screens) || screens.length === 0) {
      diagnostics.push(diag("UI_FRONTEND_NO_SCREENS", "error", `Frontend "${app.name}" must contain at least one screen.`, { nodeId: app.id }))
      continue
    }
    for (const entry of screens) {
      const id = refId(entry)
      const target = id ? ctx.getNode(id) : undefined
      if (!target || target.kind !== "screen") diagnostics.push(diag("UI_FRONTEND_SCREEN_INVALID", "error", `Frontend screen entry must reference a screen node.`, { nodeId: app.id, details: { screen: id } }))
    }
  }
  return diagnostics
})
