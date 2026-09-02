import { isNodeBuilder, nodeBuilder, serializeValue, toReference, type SpecNodeBuilder } from "@spec/core"

export interface ReactStackInput {
  react?: string
  reactDom?: string
  vite?: string
  typescript?: string
  playwright?: string
}

export interface ReactInput {
  frontend: unknown
  port?: number
  stack?: ReactStackInput
}

export function react(input: ReactInput): SpecNodeBuilder {
  return nodeBuilder("@spec/react", "react", undefined, {
    frontend: isNodeBuilder(input?.frontend) ? toReference(input.frontend) : serializeValue(input?.frontend),
    port: input?.port ?? 4173,
    stack: serializeValue(input?.stack ?? {}),
  })
}
