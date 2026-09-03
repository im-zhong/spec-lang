/**
 * Core DSL: the small vocabulary every specification can use regardless
 * of which domain packages are installed.
 *
 * These are builder factories. The compiler invokes them during static
 * evaluation of a `.spec.ts` file; user specifications are never executed
 * as ordinary JavaScript.
 */
import { isNodeBuilder, nodeBuilder, serializeValue, toReference, type SpecNodeBuilder } from "./builder"
import type { Constraint } from "./types"

export interface AppSpecInput {
  name: string
  entities?: SpecNodeBuilder[]
  services?: SpecNodeBuilder[]
  resources?: SpecNodeBuilder[]
  modules?: SpecNodeBuilder[]
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
    ["modules", input.modules],
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

export interface InterfaceOperationInput {
  input?: unknown
  output: unknown
  errors?: Record<string, unknown>
  /** Required by composite HTTP providers/callers. */
  transport?: { method: string; path: string }
}

export interface InterfaceInput {
  protocol?: string
  version?: string
  operations: Record<string, InterfaceOperationInput>
}

export interface InterfaceCall {
  readonly __specInterfaceCall: true
  interface: { nodeId: string }
  operations: string[]
}

export interface ModuleInput {
  /** Generation target/profile, e.g. "fastapi" or "react". */
  target: string
  provides?: SpecNodeBuilder[]
  calls?: InterfaceCall[]
  /** Spec nodes whose private implementation belongs to this generation unit. */
  contains?: SpecNodeBuilder[]
}

function defineInterface(name: string, input: InterfaceInput): SpecNodeBuilder {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("spec.interface: name must be a non-empty string")
  }
  if (!input || typeof input.operations !== "object" || Array.isArray(input.operations)) {
    throw new TypeError("spec.interface: operations must be an object")
  }
  return nodeBuilder("@spec/core", "interface", name, {
    protocol: input.protocol ?? "request-response",
    version: input.version ?? "1",
    operations: serializeValue(input.operations),
  })
}

function callInterface(contract: SpecNodeBuilder, ...operations: string[]): InterfaceCall {
  if (!isNodeBuilder(contract) || contract.kind !== "interface") {
    throw new TypeError("spec.call: first argument must be an interface")
  }
  if (operations.some((operation) => typeof operation !== "string" || operation.length === 0)) {
    throw new TypeError("spec.call: operation names must be non-empty strings")
  }
  return {
    __specInterfaceCall: true,
    interface: toReference(contract),
    operations: [...new Set(operations)].sort(),
  }
}

function defineModule(name: string, input: ModuleInput): SpecNodeBuilder {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("spec.module: name must be a non-empty string")
  }
  if (!input || typeof input.target !== "string" || input.target.length === 0) {
    throw new TypeError("spec.module: target must be a non-empty string")
  }
  const provides = input.provides ?? []
  if (provides.some((item) => !isNodeBuilder(item) || item.kind !== "interface")) {
    throw new TypeError("spec.module: provides must contain interfaces")
  }
  const calls = input.calls ?? []
  if (calls.some((item) => !item || item.__specInterfaceCall !== true)) {
    throw new TypeError("spec.module: calls must contain spec.call(...) values")
  }
  const contains = input.contains ?? []
  if (contains.some((item) => !isNodeBuilder(item))) {
    throw new TypeError("spec.module: contains must contain spec nodes")
  }
  return nodeBuilder("@spec/core", "module", name, {
    target: input.target,
    provides: provides.map(toReference),
    calls: serializeValue(calls),
    contains: contains.map(toReference),
  })
}

/** Core language keywords are namespaced because `interface` is reserved by TypeScript. */
export const spec = {
  interface: defineInterface,
  module: defineModule,
  call: callInterface,
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
