import {
  isNodeBuilder,
  nodeBuilder,
  serializeValue,
  toReference,
  type SpecNodeBuilder,
} from "@spec/core"
import type { UiComponent, UiState } from "./model"

export interface ScreenInput {
  path: string
  title: string
  state?: UiState[]
  body: UiComponent
}

export function screen(name: string, input: ScreenInput): SpecNodeBuilder {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("screen: first argument must be a non-empty name string")
  }
  return nodeBuilder("@spec/ui", "screen", name, {
    path: input?.path,
    title: input?.title,
    state: serializeValue(input?.state ?? []),
    body: serializeValue(input?.body),
  })
}

export interface ThemeInput {
  accent?: "indigo" | "blue" | "emerald" | "rose"
  density?: "compact" | "comfortable"
  radius?: "small" | "medium" | "large"
}

export interface FrontendInput {
  title: string
  screens: unknown
  theme?: ThemeInput
}

export function frontend(input: FrontendInput): SpecNodeBuilder {
  const screens = Array.isArray(input?.screens)
    ? input.screens.map((item) => isNodeBuilder(item) ? toReference(item) : serializeValue(item))
    : serializeValue(input?.screens)
  return nodeBuilder("@spec/ui", "frontend", undefined, {
    title: input?.title,
    screens,
    theme: serializeValue({
      accent: input?.theme?.accent ?? "indigo",
      density: input?.theme?.density ?? "comfortable",
      radius: input?.theme?.radius ?? "medium",
    }),
  })
}
