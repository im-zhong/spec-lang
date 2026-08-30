/**
 * Minimal page / api builders. The MVP focuses on entity + field; page and
 * api exist as vocabulary placeholders so the package surface is stable.
 */
import { nodeBuilder, serializeValue, type SpecNodeBuilder } from "@spec/core"

export interface PageInput {
  path: string
  title?: string
}

export function page(input: PageInput): SpecNodeBuilder {
  return nodeBuilder("@spec/web", "page", input?.path, {
    path: input?.path,
    ...("title" in (input ?? {}) ? { title: input.title } : {}),
  })
}

export interface ApiInput {
  path: string
  method?: string
  input?: unknown
  output?: unknown
}

export function api(input: ApiInput): SpecNodeBuilder {
  return nodeBuilder("@spec/web", "api", input?.path, {
    path: input?.path,
    ...("method" in (input ?? {}) ? { method: input.method } : {}),
    ...(input && "input" in input ? { input: serializeValue(input.input) } : {}),
    ...(input && "output" in input ? { output: serializeValue(input.output) } : {}),
  })
}
