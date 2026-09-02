/**
 * @spec/package-sdk — the authoring surface for specification packages.
 *
 * A spec package is a composable semantic compiler extension: vocabulary
 * (builders exported from its index), semantics (validators), capabilities,
 * and lowering rules. Third parties can publish packages such as
 * `@alice/spec-redis` without touching @spec/compiler.
 */
import type {
  CapabilityDefinition,
  Diagnostic,
  GenerationContribution,
  NodeKindDefinition,
  NodeInspector,
  SpecLowering,
  SpecLoweringFn,
  SpecPackage,
  SpecValidator,
  SpecValidatorFn,
  ValidationContext,
} from "@spec/core"

export interface PackageDefinitionInput {
  name: string
  version: string
  nodeKinds?: NodeKindDefinition[]
  capabilities?: Array<CapabilityDefinition | CapabilityClause>
  validators?: SpecValidator[]
  lowerings?: SpecLowering[]
  generation?: GenerationContribution[]
  inspectors?: Record<string, NodeInspector>
  metadata?: Record<string, unknown>
}

/** `provides("Cache")` — declare a capability this package's nodes offer. */
export interface ProvidesClause {
  provides: string
}

/** `requires("RelationalStore")` — declare a capability this package needs. */
export interface RequiresClause {
  requires: string
}

export type CapabilityClause = ProvidesClause | RequiresClause

export function provides(capability: string): ProvidesClause {
  return { provides: capability }
}

export function requires(capability: string): RequiresClause {
  return { requires: capability }
}

/** Define a complete specification package. */
export function definePackage(input: PackageDefinitionInput): SpecPackage {
  const capabilities: CapabilityDefinition[] = []
  const requirementClauses: RequiresClause[] = []
  for (const c of input.capabilities ?? []) {
    if ("provides" in c) {
      capabilities.push({ name: c.provides, package: input.name })
    } else if ("requires" in c) {
      requirementClauses.push(c)
    }
  }
  return {
    name: input.name,
    version: input.version,
    nodeKinds: input.nodeKinds,
    capabilities,
    validators: input.validators,
    lowerings: input.lowerings,
    generation: input.generation,
    inspectors: input.inspectors,
    metadata: {
      ...(input.metadata ?? {}),
      requires: requirementClauses.map((c) => c.requires),
    },
  }
}

/**
 * Define a JSON-serializable generation contribution. The helper clones and
 * sorts maps so package authors cannot accidentally leak mutable input or
 * insertion-order differences into the IR.
 */
export function defineGeneration(
  contribution: GenerationContribution,
): GenerationContribution {
  return {
    id: contribution.id,
    target: contribution.target,
    ...(contribution.nodeKinds
      ? { nodeKinds: [...contribution.nodeKinds].sort() }
      : {}),
    tasks: [...contribution.tasks],
    instructions: [...contribution.instructions],
    ...(contribution.dependencies
      ? { dependencies: sortRecord(contribution.dependencies) }
      : {}),
    ...(contribution.devDependencies
      ? { devDependencies: sortRecord(contribution.devDependencies) }
      : {}),
  }
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  )
}

/** Register a node kind (with optional per-node validation). */
export function defineNode(kind: string, validate?: NodeKindDefinition["validate"]): NodeKindDefinition {
  return validate ? { kind, validate } : { kind }
}

/** Register a package-level semantic validator. */
export function defineValidator(name: string, run: SpecValidatorFn): SpecValidator {
  return { name, run }
}

/** Register a lowering rule (MVP: interface only). */
export function defineLowering(name: string, from: string, to: string, apply: SpecLoweringFn): SpecLowering {
  return { name, from, to, apply }
}

/** Convenience: build a Diagnostic inside validators. */
export function diag(
  code: string,
  level: Diagnostic["level"],
  message: string,
  extra: Omit<Diagnostic, "code" | "level" | "message"> = {},
): Diagnostic {
  return { code, level, message, ...extra }
}

export type { ValidationContext }
