import type { SpecIR, SpecInterfaceDefinition, SpecModuleDefinition, SpecNode } from "@spec/core"

export interface IncrementalModuleDecision {
  moduleId: string
  action: "regenerate" | "reuse"
  reason: "new-module" | "module-input-changed" | "unchanged"
  previousInputHash?: string
  inputHash: string
}

export interface IncrementalGenerationPlan {
  schemaVersion: "spec-incremental-plan/0.1"
  changedInterfaces: string[]
  modules: IncrementalModuleDecision[]
  /** All entries are independent generation roots over frozen interfaces. */
  parallel: string[]
  removedModules: string[]
}

export interface InterfaceModuleGenerationTask {
  id: string
  moduleId: string
  target: string
  inputHash: string
  /** Interface boundaries are frozen inputs, never execution dependencies. */
  dependsOn: []
  contract: {
    provides: SpecInterfaceDefinition[]
    calls: Array<{ definition: SpecInterfaceDefinition; operations: string[] }>
  }
  specNodeIds: string[]
}

export interface InterfaceModuleGenerationDag {
  schemaVersion: "spec-interface-module-dag/0.1"
  tasks: InterfaceModuleGenerationTask[]
  invalidationEdges: SpecIR["interfaces"]["dependencies"]
}

function flatten(nodes: readonly SpecNode[]): SpecNode[] {
  const output: SpecNode[] = []
  const visit = (node: SpecNode) => {
    output.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  nodes.forEach(visit)
  return output
}

/**
 * Produce the exact IR view owned by one module. References outside
 * `contains` are deliberately not followed: declaring module ownership is a
 * contract, and a missing target dependency must fail lowering before any
 * agent is started.
 */
export function sliceIrForModule(current: SpecIR, module: SpecModuleDefinition): SpecIR {
  const all = flatten(current.nodes)
  const selected = new Set([
    module.sourceNodeId,
    ...module.contains,
    ...module.provides,
    ...module.calls.map((call) => call.interfaceId),
  ])
  const roots = current.nodes.filter((node) => node.kind === "app" || selected.has(node.id))
  const activePackages = new Set(flatten(roots).map((node) => node.package))
  const interfaceIds = new Set([...module.provides, ...module.calls.map((call) => call.interfaceId)])
  return {
    ...current,
    nodes: roots,
    packages: current.packages.filter((item) => activePackages.has(item.name)),
    capabilities: {
      required: current.capabilities.required.filter((item) => selected.has(item.requester)),
      provided: current.capabilities.provided.filter((item) => selected.has(item.provider)),
    },
    interfaces: {
      definitions: current.interfaces.definitions.filter((item) => interfaceIds.has(item.id)),
      bindings: current.interfaces.bindings.filter((item) => item.moduleId === module.id),
      dependencies: current.interfaces.dependencies.filter(
        (item) => item.providerModuleId === module.id || item.consumerModuleId === module.id,
      ),
    },
    modules: [module],
    generation: {
      contributions: current.generation.contributions.filter(
        (item) => activePackages.has(item.package) || item.target === module.target,
      ),
    },
  }
}

/**
 * Compare two emitted IRs without inspecting generated code. A module input
 * hash includes its own declaration and every provided/called interface hash,
 * so an interface change invalidates both sides while an unchanged boundary
 * permits byte-for-byte reuse of the previous module result.
 */
export function planIncrementalGeneration(
  current: SpecIR,
  previous?: SpecIR,
): IncrementalGenerationPlan {
  const previousInterfaces = new Map(
    (previous?.interfaces?.definitions ?? []).map((item) => [item.id, item.hash]),
  )
  const currentInterfaces = new Map(current.interfaces.definitions.map((item) => [item.id, item.hash]))
  const changedInterfaces = [...new Set([
    ...[...currentInterfaces].filter(([id, hash]) => previousInterfaces.get(id) !== hash).map(([id]) => id),
    ...[...previousInterfaces.keys()].filter((id) => !currentInterfaces.has(id)),
  ])].sort()

  const previousModules = new Map((previous?.modules ?? []).map((item) => [item.id, item]))
  const modules: IncrementalModuleDecision[] = current.modules
    .map((module): IncrementalModuleDecision => {
      const before = previousModules.get(module.id)
      if (!before) {
        return { moduleId: module.id, action: "regenerate", reason: "new-module", inputHash: module.inputHash }
      }
      if (before.inputHash !== module.inputHash) {
        return {
          moduleId: module.id,
          action: "regenerate",
          reason: "module-input-changed",
          previousInputHash: before.inputHash,
          inputHash: module.inputHash,
        }
      }
      return {
        moduleId: module.id,
        action: "reuse",
        reason: "unchanged",
        previousInputHash: before.inputHash,
        inputHash: module.inputHash,
      }
    })
    .sort((a, b) => a.moduleId.localeCompare(b.moduleId))

  return {
    schemaVersion: "spec-incremental-plan/0.1",
    changedInterfaces,
    modules,
    parallel: modules.filter((item) => item.action === "regenerate").map((item) => item.moduleId),
    removedModules: [...previousModules.keys()].filter((id) => !current.modules.some((item) => item.id === id)).sort(),
  }
}

/** Lower affected modules to independent target-generation roots. */
export function planInterfaceModuleGeneration(
  current: SpecIR,
  previous?: SpecIR,
): InterfaceModuleGenerationDag {
  const incremental = planIncrementalGeneration(current, previous)
  const regenerate = new Set(incremental.parallel)
  const interfaces = new Map(current.interfaces.definitions.map((item) => [item.id, item]))
  const tasks = current.modules
    .filter((module) => regenerate.has(module.id))
    .map((module): InterfaceModuleGenerationTask => ({
      id: `generate:${module.id}`,
      moduleId: module.id,
      target: module.target,
      inputHash: module.inputHash,
      dependsOn: [],
      contract: {
        provides: module.provides.map((id) => interfaces.get(id)).filter((item): item is SpecInterfaceDefinition => item !== undefined),
        calls: module.calls.flatMap((call) => {
          const definition = interfaces.get(call.interfaceId)
          return definition ? [{ definition, operations: [...call.operations] }] : []
        }),
      },
      specNodeIds: [...new Set([module.sourceNodeId, ...module.contains, ...module.provides, ...module.calls.map((call) => call.interfaceId)])].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return {
    schemaVersion: "spec-interface-module-dag/0.1",
    tasks,
    invalidationEdges: [...current.interfaces.dependencies],
  }
}
