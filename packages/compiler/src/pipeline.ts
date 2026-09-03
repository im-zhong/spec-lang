/**
 * Compiler passes: Parse -> Resolve -> Normalize -> Validate -> Link ->
 * Lower -> Emit.
 *
 * Validation layers (spec §42) map to passes:
 *   L1 TypeScript syntax ....... ParsePass (syntax diagnostics)
 *   L2 spec syntax restrictions  ParsePass + evaluator
 *   L3 core semantics ........... NormalizePass (ids, collisions, app shape)
 *   L4 package semantics ........ ValidatePass (package validators)
 *   L5 cross-package semantics .. LinkPass (capabilities)
 *   L6 formal verification ...... future (LowerPass extension point)
 *
 * The compiler core contains NO domain (web/auth/postgres) logic — it only
 * knows packages, nodes, validators, capabilities and passes.
 */
import * as path from "node:path"
import { createHash } from "node:crypto"
import type {
  CapabilityProvider,
  CapabilityRequirement,
  Diagnostic,
  MaterializedGenerationContribution,
  SpecIR,
  SpecInterfaceBinding,
  SpecInterfaceDefinition,
  SpecInterfaceDependency,
  SpecModuleDefinition,
  SpecNode,
  ValidationContext,
} from "@spec/core"
import { isNodeBuilder, nodeId, serializeValue, stableStringify, type SpecNodeBuilder } from "@spec/core"
import { diagnostic } from "./diagnostics"
import { evaluateSpec, type EvaluationResult, type ImportedBinding } from "./evaluate"
import { PackageLoader, loadFailureDiagnostic, type LoadedSpecPackage } from "./loader"
import { parseSpecFile, type ParsedSpec } from "./parse"
import { COMPILER_VERSION, SPEC_VERSION } from "./version"
import { SPEC_IR_VERSION } from "@spec/core"

/* ------------------------------------------------------------------ */
/* Compilation state                                                   */
/* ------------------------------------------------------------------ */

export interface Compilation {
  /** Display path (project-relative) used in artifacts. */
  entry: string
  /** Absolute path of the entry file. */
  entryPath: string
  parsed?: ParsedSpec
  imports?: Map<string, ImportedBinding>
  loadedPackages: LoadedSpecPackage[]
  evaluation?: EvaluationResult
  /** Normalized IR nodes (roots; children nested). */
  nodes: SpecNode[]
  capabilities: {
    required: CapabilityRequirement[]
    provided: CapabilityProvider[]
  }
  interfaces: {
    definitions: SpecInterfaceDefinition[]
    bindings: SpecInterfaceBinding[]
    dependencies: SpecInterfaceDependency[]
  }
  modules: SpecModuleDefinition[]
  diagnostics: Diagnostic[]
  generationContributions: MaterializedGenerationContribution[]
  ir?: SpecIR
}

export interface SpecManifest {
  specVersion: string
  compilerVersion: string
  entry: string
  packages: Record<string, string>
}

/* ------------------------------------------------------------------ */
/* Passes                                                              */
/* ------------------------------------------------------------------ */

export function parsePass(compilation: Compilation): Compilation {
  const parsed = parseSpecFile(compilation.entryPath, compilation.entry)
  compilation.parsed = parsed
  compilation.diagnostics.push(...parsed.diagnostics)
  return compilation
}

export function resolvePass(compilation: Compilation): Compilation {
  const parsed = compilation.parsed
  if (!parsed) return compilation
  const loader = new PackageLoader(path.dirname(compilation.entryPath))
  const imports = new Map<string, ImportedBinding>()
  for (const parsedImport of parsed.imports) {
    const loaded = loader.load(parsedImport.moduleSpecifier)
    if (loaded instanceof Error) {
      compilation.diagnostics.push(loadFailureDiagnostic(parsedImport.moduleSpecifier, loaded))
      continue
    }
    if (!compilation.loadedPackages.some((p) => p.name === loaded.name)) {
      compilation.loadedPackages.push(loaded)
    }
    for (const { imported, local } of parsedImport.named) {
      if (!(imported in loaded.exports)) {
        compilation.diagnostics.push(
          diagnostic(
            "SPEC_UNKNOWN_IMPORT",
            "error",
            `Package "${loaded.name}" has no export named "${imported}".`,
            { details: { package: loaded.name, imported } },
          ),
        )
        continue
      }
      imports.set(local, { packageName: loaded.name, imported, value: loaded.exports[imported] })
    }
  }
  compilation.imports = imports
  compilation.loadedPackages.sort((a, b) => (a.name < b.name ? -1 : 1))
  return compilation
}

export function normalizePass(compilation: Compilation): Compilation {
  const parsed = compilation.parsed
  if (!parsed || !compilation.imports) return compilation
  const evaluation = evaluateSpec(parsed, compilation.imports)
  compilation.evaluation = evaluation
  compilation.diagnostics.push(...evaluation.diagnostics)

  // Root nodes: the app node plus every const-bound node builder,
  // deduplicated by identity (the same entity referenced twice must
  // materialize once).
  const rootBuilders: SpecNodeBuilder[] = []
  const seen = new Set<SpecNodeBuilder>()
  if (evaluation.appNode && !seen.has(evaluation.appNode)) {
    rootBuilders.push(evaluation.appNode)
    seen.add(evaluation.appNode)
  }
  for (const node of evaluation.nodes) {
    if (!seen.has(node)) {
      rootBuilders.push(node)
      seen.add(node)
    }
  }

  const nodesById = new Map<string, SpecNode>()
  // Nodes reachable as roots are never duplicated as children of another
  // node (e.g. entities listed in defineApp are already roots via their
  // const bindings); child links to them are simply dropped.
  const sharedRoots = new Set(rootBuilders)
  for (const builder of rootBuilders) {
    const materialized = materialize(builder, null, 0, sharedRoots)
    if (nodesById.has(materialized.id)) {
      // Same deterministic id (e.g. duplicate entity names). Keep BOTH
      // nodes so package validators can diagnose the duplication; ids are
      // made unique with a deterministic suffix.
      let counter = 2
      while (nodesById.has(`${materialized.id}#${counter}`)) counter++
      materialized.id = `${materialized.id}#${counter}`
      compilation.diagnostics.push(
        diagnostic(
          "NODE_ID_COLLISION",
          "error",
          `Two spec nodes share the deterministic id derived from kind/name "${builder.kind}:${builder.name}" (duplicate name?).`,
          { nodeId: materialized.id, details: { kind: materialized.kind, name: builder.name } },
        ),
      )
    }
    nodesById.set(materialized.id, materialized)
  }

  compilation.nodes = [...nodesById.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
  return compilation
}

function materialize(
  builder: SpecNodeBuilder,
  parentId: string | null,
  index: number,
  sharedRoots: Set<SpecNodeBuilder>,
): SpecNode {
  const id = builder.name
    ? nodeId(builder.kind, builder.name)
    : `${builder.kind}:${parentId ?? "root"}#${index}`
  const attributes = serializeValue(builder.attributes) as Record<string, unknown>
  const children = (builder.children ?? [])
    .filter((child) => !sharedRoots.has(child))
    .map((child, childIndex) => materialize(child, id, childIndex, sharedRoots))
  const node: SpecNode = {
    id,
    kind: builder.kind,
    package: builder.package,
    ...(builder.name === undefined ? {} : { name: builder.name }),
    attributes: (attributes ?? {}) as Record<string, unknown>,
    ...(children.length > 0 ? { children } : {}),
    ...(builder.source ? { source: builder.source } : {}),
  }
  return node
}

export function validatePass(compilation: Compilation): Compilation {
  const all = flattenAll(compilation.nodes)
  const byId = new Map(all.map((node) => [node.id, node]))
  const reported: Diagnostic[] = []
  const context: ValidationContext = {
    nodes: compilation.nodes,
    getNode: (id) => byId.get(id),
    findNodes: (kind) => all.filter((node) => node.kind === kind),
    report: (d) => reported.push(d),
  }

  // Layer 4: package semantics — validators and per-kind checks supplied
  // by loaded packages. Deterministic order: package name, then
  // registration order.
  for (const pkg of compilation.loadedPackages) {
    for (const validator of pkg.definition.validators ?? []) {
      const produced = validator.run(context)
      if (produced) reported.push(...produced)
    }
    for (const nodeKind of pkg.definition.nodeKinds ?? []) {
      if (!nodeKind.validate) continue
      for (const node of all.filter((n) => n.kind === nodeKind.kind)) {
        const produced = nodeKind.validate(node, context)
        if (produced) reported.push(...produced)
      }
    }
  }

  compilation.diagnostics.push(...reported)
  return compilation
}

export function linkPass(compilation: Compilation): Compilation {
  const all = flattenAll(compilation.nodes)
  const provided: CapabilityProvider[] = []
  const required: CapabilityRequirement[] = []

  for (const node of all) {
    for (const capability of capabilityList(node.attributes.provides)) {
      provided.push({ capability, provider: node.id })
    }
    for (const capability of capabilityList(node.attributes.requires)) {
      required.push({ capability, requester: node.id })
    }
  }

  linkInterfaces(compilation, all)
  const moduleByNode = new Map(
    compilation.modules.flatMap((module) => module.contains.map((nodeId) => [nodeId, module.id] as const)),
  )

  for (const requirement of required) {
    const requesterModule = moduleByNode.get(requirement.requester)
    const providers = provided.filter((provider) =>
      provider.capability === requirement.capability &&
      (!requesterModule || moduleByNode.get(provider.provider) === requesterModule),
    )
    if (providers.length === 0) {
      compilation.diagnostics.push(
        diagnostic(
          "MISSING_CAPABILITY_PROVIDER",
          "error",
          `"${requirement.requester}" requires capability "${requirement.capability}" but no${requesterModule ? " provider in its module" : " spec node"} provides it.`,
          {
            nodeId: requirement.requester,
            details: { capability: requirement.capability, requester: requirement.requester },
          },
        ),
      )
    } else if (providers.length > 1) {
      compilation.diagnostics.push(
        diagnostic(
          "DUPLICATE_CAPABILITY_PROVIDER",
          "warning",
          `Capability "${requirement.capability}" is provided by multiple nodes: ${providers
            .map((p) => p.provider)
            .sort()
            .join(", ")}.`,
          { details: { capability: requirement.capability, providers: providers.map((p) => p.provider).sort() } },
        ),
      )
    }
  }

  compilation.capabilities = {
    required: required.sort(compareCapabilities),
    provided: provided.sort(compareCapabilities),
  }
  return compilation
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`
}

function referenceId(value: unknown): string | undefined {
  return isPlainRecord(value) && typeof value.nodeId === "string" ? value.nodeId : undefined
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function linkInterfaces(compilation: Compilation, all: SpecNode[]): void {
  const interfaceNodes = all.filter((node) => node.kind === "interface").sort((a, b) => a.id.localeCompare(b.id))
  const definitions: SpecInterfaceDefinition[] = []
  for (const node of interfaceNodes) {
    const operationsValue = node.attributes.operations
    if (!isPlainRecord(operationsValue) || Object.keys(operationsValue).length === 0) {
      compilation.diagnostics.push(diagnostic(
        "INTERFACE_OPERATIONS_EMPTY",
        "error",
        `Interface "${node.name ?? node.id}" must declare at least one operation.`,
        { nodeId: node.id },
      ))
      continue
    }
    const protocol = typeof node.attributes.protocol === "string" ? node.attributes.protocol : "request-response"
    const operations: SpecInterfaceDefinition["operations"] = {}
    for (const operationName of Object.keys(operationsValue).sort()) {
      const operation = operationsValue[operationName]
      if (!isPlainRecord(operation) || !("output" in operation)) {
        compilation.diagnostics.push(diagnostic(
          "INTERFACE_OPERATION_INVALID",
          "error",
          `Interface operation "${node.name ?? node.id}.${operationName}" must declare output.`,
          { nodeId: node.id, details: { operation: operationName } },
        ))
        continue
      }
      const transport = isPlainRecord(operation.transport) &&
        typeof operation.transport.method === "string" && /^[A-Za-z]+$/.test(operation.transport.method) &&
        typeof operation.transport.path === "string" && operation.transport.path.startsWith("/")
        ? { method: operation.transport.method.toUpperCase(), path: operation.transport.path }
        : undefined
      if (protocol === "http-json" && !transport) {
        compilation.diagnostics.push(diagnostic(
          "INTERFACE_HTTP_TRANSPORT_REQUIRED",
          "error",
          `HTTP interface operation "${node.name ?? node.id}.${operationName}" must declare transport { method, path } with an absolute path.`,
          { nodeId: node.id, details: { operation: operationName } },
        ))
      }
      operations[operationName] = {
        ...(operation.input === undefined ? {} : { input: operation.input }),
        output: operation.output,
        ...(isPlainRecord(operation.errors) ? { errors: operation.errors } : {}),
        ...(transport ? { transport } : {}),
      }
    }
    const version = typeof node.attributes.version === "string" ? node.attributes.version : "1"
    definitions.push({
      id: node.id,
      name: node.name ?? node.id,
      protocol,
      version,
      operations,
      hash: sha256({ protocol, version, operations }),
      sourceNodeId: node.id,
    })
  }

  const byInterface = new Map(definitions.map((definition) => [definition.id, definition]))
  const byNode = new Map(all.map((node) => [node.id, node]))
  const moduleNodes = all.filter((node) => node.kind === "module").sort((a, b) => a.id.localeCompare(b.id))
  const bindings: SpecInterfaceBinding[] = []
  const pendingModules: Array<Omit<SpecModuleDefinition, "inputHash">> = []

  for (const node of moduleNodes) {
    const providedIds = Array.isArray(node.attributes.provides)
      ? node.attributes.provides.map(referenceId).filter((id): id is string => id !== undefined).sort()
      : []
    const calls: Array<{ interfaceId: string; operations: string[] }> = []
    for (const raw of Array.isArray(node.attributes.calls) ? node.attributes.calls : []) {
      if (!isPlainRecord(raw)) continue
      const interfaceId = referenceId(raw.interface)
      if (!interfaceId) continue
      const operations = Array.isArray(raw.operations)
        ? raw.operations.filter((name): name is string => typeof name === "string").sort()
        : []
      calls.push({ interfaceId, operations })
    }
    const contains = Array.isArray(node.attributes.contains)
      ? node.attributes.contains.map(referenceId).filter((id): id is string => id !== undefined).sort()
      : []
    for (const interfaceId of providedIds) {
      if (!byInterface.has(interfaceId)) {
        compilation.diagnostics.push(diagnostic("INTERFACE_UNKNOWN", "error", `Module "${node.name ?? node.id}" provides unknown interface "${interfaceId}".`, { nodeId: node.id }))
      }
      bindings.push({ moduleId: node.id, interfaceId, role: "provides", operations: [] })
    }
    for (const call of calls) {
      const definition = byInterface.get(call.interfaceId)
      if (!definition) {
        compilation.diagnostics.push(diagnostic("INTERFACE_UNKNOWN", "error", `Module "${node.name ?? node.id}" calls unknown interface "${call.interfaceId}".`, { nodeId: node.id }))
      } else {
        for (const operation of call.operations) {
          if (!(operation in definition.operations)) {
            compilation.diagnostics.push(diagnostic(
              "INTERFACE_OPERATION_UNKNOWN",
              "error",
              `Module "${node.name ?? node.id}" calls unknown operation "${definition.name}.${operation}".`,
              { nodeId: node.id, details: { interfaceId: call.interfaceId, operation } },
            ))
          }
        }
      }
      bindings.push({ moduleId: node.id, interfaceId: call.interfaceId, role: "calls", operations: call.operations })
    }
    pendingModules.push({
      id: node.id,
      name: node.name ?? node.id,
      target: typeof node.attributes.target === "string" ? node.attributes.target : "unknown",
      sourceNodeId: node.id,
      provides: providedIds,
      calls,
      contains,
    })
  }

  if (moduleNodes.length > 0) {
    const owners = new Map<string, string[]>()
    for (const module of pendingModules) {
      for (const contained of module.contains) {
        const target = byNode.get(contained)
        if (!target) {
          compilation.diagnostics.push(diagnostic(
            "MODULE_CONTAINS_UNKNOWN",
            "error",
            `Module "${module.name}" contains unknown node "${contained}".`,
            { nodeId: module.id, details: { contained } },
          ))
          continue
        }
        if (["app", "interface", "module"].includes(target.kind)) {
          compilation.diagnostics.push(diagnostic(
            "MODULE_CONTAINS_BOUNDARY_NODE",
            "error",
            `Module "${module.name}" cannot own boundary node "${contained}".`,
            { nodeId: module.id, details: { contained, kind: target.kind } },
          ))
          continue
        }
        const values = owners.get(contained) ?? []
        values.push(module.id)
        owners.set(contained, values)
      }
    }
    for (const [contained, moduleIds] of [...owners].sort(([a], [b]) => a.localeCompare(b))) {
      if (moduleIds.length > 1) {
        compilation.diagnostics.push(diagnostic(
          "MODULE_OWNERSHIP_OVERLAP",
          "error",
          `Implementation node "${contained}" is owned by multiple modules: ${moduleIds.sort().join(", ")}.`,
          { nodeId: contained, details: { modules: moduleIds.sort() } },
        ))
      }
    }
    for (const node of compilation.nodes.filter((item) => !["app", "interface", "module"].includes(item.kind))) {
      if (!owners.has(node.id)) {
        compilation.diagnostics.push(diagnostic(
          "MODULE_NODE_UNOWNED",
          "error",
          `Implementation node "${node.id}" must be owned by exactly one spec.module via contains.`,
          { nodeId: node.id },
        ))
      }
    }
  }

  const dependencies: SpecInterfaceDependency[] = []
  for (const call of bindings.filter((binding) => binding.role === "calls")) {
    const providers = bindings.filter((binding) => binding.role === "provides" && binding.interfaceId === call.interfaceId)
    if (providers.length !== 1) {
      compilation.diagnostics.push(diagnostic(
        providers.length === 0 ? "INTERFACE_PROVIDER_MISSING" : "INTERFACE_PROVIDER_AMBIGUOUS",
        "error",
        `Called interface "${call.interfaceId}" must have exactly one provider; found ${providers.length}.`,
        { nodeId: call.moduleId, details: { interfaceId: call.interfaceId, providers: providers.map((item) => item.moduleId).sort() } },
      ))
      continue
    }
    if (providers[0].moduleId === call.moduleId) {
      compilation.diagnostics.push(diagnostic("INTERFACE_SELF_CALL", "error", `Module "${call.moduleId}" cannot call an interface it provides.`, { nodeId: call.moduleId }))
      continue
    }
    dependencies.push({
      providerModuleId: providers[0].moduleId,
      consumerModuleId: call.moduleId,
      interfaceId: call.interfaceId,
      interfaceHash: byInterface.get(call.interfaceId)?.hash ?? sha256(null),
      operations: [...call.operations],
    })
  }

  const modules: SpecModuleDefinition[] = pendingModules.map((module) => ({
    ...module,
    inputHash: sha256({
      target: module.target,
      provides: module.provides.map((id) => ({ id, hash: byInterface.get(id)?.hash ?? null })),
      calls: module.calls.map((call) => ({ ...call, hash: byInterface.get(call.interfaceId)?.hash ?? null })),
      contains: module.contains.map((id) => ({ id, hash: sha256(byNode.get(id) ?? null) })),
    }),
  }))
  compilation.interfaces = {
    definitions,
    bindings: bindings.sort((a, b) => `${a.moduleId}\0${a.role}\0${a.interfaceId}`.localeCompare(`${b.moduleId}\0${b.role}\0${b.interfaceId}`)),
    dependencies: dependencies.sort((a, b) => `${a.providerModuleId}\0${a.consumerModuleId}\0${a.interfaceId}`.localeCompare(`${b.providerModuleId}\0${b.consumerModuleId}\0${b.interfaceId}`)),
  }
  compilation.modules = modules
}

function capabilityList(value: unknown): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : []
}

function compareCapabilities(
  a: { capability: string; requester?: string; provider?: string },
  b: { capability: string; requester?: string; provider?: string },
): number {
  if (a.capability !== b.capability) return a.capability < b.capability ? -1 : 1
  const aWho = a.requester ?? a.provider ?? ""
  const bWho = b.requester ?? b.provider ?? ""
  return aWho < bWho ? -1 : aWho > bWho ? 1 : 0
}

export function lowerPass(compilation: Compilation): Compilation {
  const activeKinds = new Set(flattenAll(compilation.nodes).map((node) => node.kind))
  const selected: MaterializedGenerationContribution[] = []

  for (const loaded of compilation.loadedPackages) {
    for (const contribution of loaded.definition.generation ?? []) {
      if (
        contribution.nodeKinds &&
        contribution.nodeKinds.length > 0 &&
        !contribution.nodeKinds.some((kind) => activeKinds.has(kind))
      ) {
        continue
      }
      selected.push({
        ...serializeValue(contribution) as typeof contribution,
        package: loaded.name,
        version: loaded.version,
      })
    }
  }

  selected.sort((left, right) => {
    const leftKey = `${left.target}\0${left.package}\0${left.id}`
    const rightKey = `${right.target}\0${right.package}\0${right.id}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })

  const ids = new Set<string>()
  const dependencyPins = new Map<string, { version: string; owner: string }>()
  for (const contribution of selected) {
    const id = `${contribution.target}:${contribution.package}:${contribution.id}`
    if (ids.has(id)) {
      compilation.diagnostics.push(
        diagnostic(
          "GENERATION_CONTRIBUTION_DUPLICATE",
          "error",
          `Generation contribution "${id}" is registered more than once.`,
          { details: { contribution: id } },
        ),
      )
    }
    ids.add(id)

    for (const [name, version] of Object.entries({
      ...(contribution.dependencies ?? {}),
      ...(contribution.devDependencies ?? {}),
    })) {
      const key = `${contribution.target}:${name}`
      const previous = dependencyPins.get(key)
      if (previous && previous.version !== version) {
        compilation.diagnostics.push(
          diagnostic(
            "GENERATION_DEPENDENCY_CONFLICT",
            "error",
            `Generation target "${contribution.target}" received conflicting pins for "${name}": "${previous.version}" from ${previous.owner} and "${version}" from ${contribution.package}.`,
            {
              details: {
                target: contribution.target,
                dependency: name,
                versions: [previous.version, version].sort(),
                packages: [previous.owner, contribution.package].sort(),
              },
            },
          ),
        )
      } else {
        dependencyPins.set(key, { version, owner: contribution.package })
      }
    }
  }

  compilation.generationContributions = selected
  return compilation
}

export function emitPass(compilation: Compilation): Compilation {
  const app = compilation.nodes.find((node) => node.kind === "app")
  compilation.ir = {
    version: SPEC_IR_VERSION,
    app: { name: (app?.name as string) ?? "unknown" },
    packages: compilation.loadedPackages.map((p) => ({ name: p.name, version: p.version })),
    nodes: compilation.nodes,
    capabilities: compilation.capabilities,
    interfaces: compilation.interfaces,
    modules: compilation.modules,
    generation: { contributions: compilation.generationContributions },
    diagnostics: compilation.diagnostics,
    metadata: { compilerVersion: COMPILER_VERSION },
  }
  return compilation
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function flattenAll(nodes: SpecNode[]): SpecNode[] {
  const out: SpecNode[] = []
  const visit = (node: SpecNode) => {
    out.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  for (const node of nodes) visit(node)
  return out
}

export function buildManifest(compilation: Compilation): SpecManifest {
  const packages: Record<string, string> = {}
  for (const pkg of compilation.loadedPackages) packages[pkg.name] = pkg.version
  return {
    specVersion: SPEC_VERSION,
    compilerVersion: COMPILER_VERSION,
    entry: compilation.entry,
    packages,
  }
}
