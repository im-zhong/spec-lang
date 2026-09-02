import { serializeValue } from "@spec/core"

export type UiValue = string | number | boolean | null | UiBinding

export interface UiBinding {
  readonly __uiBinding: true
  kind: "stateCount" | "stateValue"
  source: string
}

export interface UiAction {
  readonly __uiAction: true
  kind: "append" | "notify" | "selectTab" | "resetForm" | "sequence" | "navigate"
  [key: string]: unknown
}

export interface UiComponent {
  readonly __uiComponent: true
  kind: string
  props: Record<string, unknown>
}

export interface UiState {
  readonly __uiState: true
  kind: "collection" | "value"
  name: string
  initial: unknown
}

function component(kind: string, props: Record<string, unknown> = {}): UiComponent {
  return {
    __uiComponent: true,
    kind,
    props: serializeValue(props) as Record<string, unknown>,
  }
}

export const ui = {
  appShell(input: {
    brand: string
    navigation: Array<{ label: string; href: string; icon?: string }>
    content: UiComponent
  }): UiComponent {
    return component("appShell", input)
  },

  stack(input: { gap?: "xs" | "sm" | "md" | "lg" | "xl"; children: UiComponent[] }): UiComponent {
    return component("stack", { gap: input.gap ?? "md", children: input.children })
  },

  grid(input: {
    columns?: 1 | 2 | 3 | 4
    gap?: "xs" | "sm" | "md" | "lg" | "xl"
    children: UiComponent[]
  }): UiComponent {
    return component("grid", { columns: input.columns ?? 2, gap: input.gap ?? "md", children: input.children })
  },

  card(input: { title?: string; children: UiComponent[] }): UiComponent {
    return component("card", input)
  },

  heading(text: string, input: { level?: 1 | 2 | 3; subtitle?: string } = {}): UiComponent {
    return component("heading", { text, level: input.level ?? 1, ...(input.subtitle ? { subtitle: input.subtitle } : {}) })
  },

  text(text: string, input: { tone?: "default" | "muted" | "success" | "danger" } = {}): UiComponent {
    return component("text", { text, tone: input.tone ?? "default" })
  },

  stat(input: { label: string; value: UiValue; detail?: string }): UiComponent {
    return component("stat", input)
  },

  tabs(input: {
    id: string
    defaultValue: string
    items: UiComponent[]
    activation?: "automatic" | "manual"
  }): UiComponent {
    return component("tabs", { ...input, activation: input.activation ?? "automatic" })
  },

  tab(input: { value: string; label: string; content: UiComponent }): UiComponent {
    return component("tab", input)
  },

  form(input: {
    id: string
    fields: UiComponent[]
    submit: { label: string; action: UiAction }
  }): UiComponent {
    return component("form", input)
  },

  input(input: {
    id: string
    label: string
    placeholder?: string
    type?: "text" | "email" | "number"
    required?: boolean
  }): UiComponent {
    return component("input", { ...input, type: input.type ?? "text", required: input.required === true })
  },

  select(input: {
    id: string
    label: string
    options: Array<{ value: string; label: string }>
    required?: boolean
  }): UiComponent {
    return component("select", { ...input, required: input.required === true })
  },

  table(input: {
    source: string
    columns: Array<{ field: string; label: string; presentation?: "text" | "badge" }>
    empty: { title: string; description?: string }
  }): UiComponent {
    return component("table", input)
  },

  alert(input: { id: string; tone?: "info" | "success" | "danger" }): UiComponent {
    return component("alert", { ...input, tone: input.tone ?? "info" })
  },
}

function actionValue(kind: UiAction["kind"], props: Record<string, unknown>): UiAction {
  return { __uiAction: true, kind, ...serializeValue(props) as Record<string, unknown> }
}

export const action = {
  append(collection: string, input: { fromForm: string; fields: Record<string, string> }): UiAction {
    return actionValue("append", { collection, ...input })
  },
  notify(target: string, message: string): UiAction {
    return actionValue("notify", { target, message })
  },
  selectTab(target: string, value: string): UiAction {
    return actionValue("selectTab", { target, value })
  },
  resetForm(target: string): UiAction {
    return actionValue("resetForm", { target })
  },
  navigate(path: string): UiAction {
    return actionValue("navigate", { path })
  },
  sequence(actions: UiAction[]): UiAction {
    return actionValue("sequence", { actions })
  },
}

export const bind = {
  count(source: string): UiBinding {
    return { __uiBinding: true, kind: "stateCount", source }
  },
  value(source: string): UiBinding {
    return { __uiBinding: true, kind: "stateValue", source }
  },
}

export const state = {
  collection(name: string, initial: Array<Record<string, unknown>>): UiState {
    return { __uiState: true, kind: "collection", name, initial: serializeValue(initial) }
  },
  value(name: string, initial: UiValue): UiState {
    return { __uiState: true, kind: "value", name, initial: serializeValue(initial) }
  },
}
