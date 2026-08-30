/**
 * Core DSL: the small vocabulary every specification can use regardless
 * of which domain packages are installed.
 *
 * These are builder factories. The compiler invokes them during static
 * evaluation of a `.spec.ts` file; user specifications are never executed
 * as ordinary JavaScript.
 */
import { isNodeBuilder, nodeBuilder, type SpecNodeBuilder } from "./builder"
import type { Constraint } from "./types"

export interface AppSpecInput {
  name: string
  entities?: SpecNodeBuilder[]
  services?: SpecNodeBuilder[]
  resources?: SpecNodeBuilder[]
  [key: string]: unknown
}

/**
 * `defineApp({ name, entities, services, resources })`
 * Produces the root `app` node of the specification.
 */
export function defineApp(input: AppSpecInput): SpecNodeBuilder {
  const attributes: Record<string, unknown> = {
    name: input.name,
  }
  const children: SpecNodeBuilder[] = []
  const collections: Array<[string, SpecNodeBuilder[] | undefined]> = [
    ["entities", input.entities],
    ["services", input.services],
    ["resources", input.resources],
  ]
  for (const [key, list] of collections) {
    if (list === undefined) continue
    if (!Array.isArray(list)) {
      throw new TypeError(`defineApp: "${key}" must be an array of spec nodes`)
    }
    for (const item of list) {
      if (!isNodeBuilder(item)) {
        throw new TypeError(
          `defineApp: "${key}" contains a non-node value (use spec builders such as entity(...))`,
        )
      }
    }
    attributes[key] = list.map((n) => n.name)
    children.push(...list)
  }
  return nodeBuilder("@spec/core", "app", input.name, attributes, children)
}

/** Alias of defineApp with a neutral name. */
export function defineSpec(input: AppSpecInput): SpecNodeBuilder {
  return defineApp(input)
}

/** Create an explicit reference to a named spec node. */
export function ref(target: { kind: string; name: string } | string): { nodeId: string } {
  if (typeof target === "string") return { nodeId: target }
  return { nodeId: `${target.kind}:${target.name}` }
}

/** Attach a semantic constraint. */
export function constraint(kind: string, value?: unknown, message?: string): Constraint {
  return { kind, ...(value === undefined ? {} : { value }), ...(message ? { message } : {}) }
}
