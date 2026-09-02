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
import type {
  CapabilityProvider,
  CapabilityRequirement,
  Diagnostic,
  MaterializedGenerationContribution,
  SpecIR,
  SpecNode,
  ValidationContext,
} from "@spec/core"
import { isNodeBuilder, nodeId, serializeValue, type SpecNodeBuilder } from "@spec/core"
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

  for (const requirement of required) {
    const providers = provided.filter((p) => p.capability === requirement.capability)
    if (providers.length === 0) {
      compilation.diagnostics.push(
        diagnostic(
          "MISSING_CAPABILITY_PROVIDER",
          "error",
          `"${requirement.requester}" requires capability "${requirement.capability}" but no spec node provides it.`,
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
