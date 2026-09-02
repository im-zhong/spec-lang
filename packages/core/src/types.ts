/**
 * Core type model of the spec system.
 *
 * These types are the contract between:
 *   - the compiler (which produces IR)
 *   - specification packages (which provide vocabulary + semantics)
 *   - future agents / verifiers (which consume IR + diagnostics)
 *
 * The core layer contains NO domain concepts (no web, auth, database).
 */

/** Position of a spec construct inside a `.spec.ts` source file. */
export interface SourceLocation {
  file: string
  line: number
  column: number
}

/**
 * A first-class source reference. Everything that can point back at
 * user source code carries one of these.
 */
export interface Reference {
  nodeId: string
}

/**
 * A semantic constraint attached to a spec node or agent task.
 * MVP keeps this deliberately open; later phases can make it verifiable.
 */
export interface Constraint {
  kind: string
  value?: unknown
  message?: string
}

/** The universal node representation in the Spec IR. */
export interface SpecNode {
  id: string
  kind: string
  package: string
  name?: string
  attributes: Record<string, unknown>
  children?: SpecNode[]
  source?: SourceLocation
}

export type DiagnosticLevel = "error" | "warning" | "info"

/**
 * Structured diagnostic. This is a machine protocol, not just a human
 * message: future AI agents consume `code`/`details` to repair specs.
 */
export interface Diagnostic {
  code: string
  level: DiagnosticLevel
  message: string
  source?: SourceLocation
  nodeId?: string
  details?: Record<string, unknown>
}

export interface PackageReference {
  name: string
  version: string
}

/**
 * A deterministic, package-owned contribution to an agent generation
 * target. Contributions are data (and therefore become part of the IR),
 * not callbacks: the same package versions and spec always yield the same
 * dependency pins and prompt guidance.
 */
export interface GenerationContribution {
  /** Stable id within the package, e.g. "python-baseline". */
  id: string
  /** Generation target profile, e.g. "fastapi-python". */
  target: string
  /** Node kinds which activate this contribution. Empty/omitted = always. */
  nodeKinds?: string[]
  /** Target-defined task kinds which receive the instructions. */
  tasks: string[]
  /** Concise, imperative guidance composed into matching task prompts. */
  instructions: string[]
  /** Exact runtime dependency pins contributed to the generated project. */
  dependencies?: Record<string, string>
  /** Exact development dependency pins contributed to the generated project. */
  devDependencies?: Record<string, string>
}

/** A selected contribution with package provenance attached by the compiler. */
export interface MaterializedGenerationContribution extends GenerationContribution {
  package: string
  version: string
}

/** A package needs a capability provided by someone else. */
export interface CapabilityRequirement {
  capability: string
  requester: string
}

/** A package / node provides a capability. */
export interface CapabilityProvider {
  capability: string
  provider: string
}

/** Versioned, deterministic, JSON-serializable compilation result. */
export interface SpecIR {
  version: string
  app: {
    name: string
  }
  packages: PackageReference[]
  nodes: SpecNode[]
  capabilities: {
    required: CapabilityRequirement[]
    provided: CapabilityProvider[]
  }
  generation: {
    contributions: MaterializedGenerationContribution[]
  }
  diagnostics: Diagnostic[]
  metadata: {
    compilerVersion: string
    /**
     * Optional nondeterministic metadata. NEVER participates in the
     * deterministic artifact hash; compilers MAY omit it entirely.
     */
    generatedAt?: string
  }
}

export const SPEC_IR_VERSION = "spec-ir/0.2"

/* ------------------------------------------------------------------ */
/* Package model                                                       */
/* ------------------------------------------------------------------ */

/**
 * Context handed to package validators. It only exposes generic
 * structural queries — no domain knowledge lives here.
 */
export interface ValidationContext {
  /** All nodes in the current compilation, in deterministic order. */
  readonly nodes: readonly SpecNode[]
  getNode(id: string): SpecNode | undefined
  findNodes(kind: string): SpecNode[]
  report(diagnostic: Diagnostic): void
}

export type SpecValidatorFn = (context: ValidationContext) => Diagnostic[] | void

export interface SpecValidator {
  name: string
  run: SpecValidatorFn
}

export interface NodeKindDefinition {
  kind: string
  validate?: (node: SpecNode, context: ValidationContext) => Diagnostic[]
}

export interface CapabilityDefinition {
  name: string
  package: string
}

export type SpecLoweringFn = (node: SpecNode, context: unknown) => unknown

export interface SpecLowering {
  name: string
  from: string
  to: string
  apply: SpecLoweringFn
}

/**
 * Optional human-readable rendering hook. Packages may register an
 * inspector per node kind so `spec inspect` can display domain-meaningful
 * trees without the compiler learning any domain concepts.
 */
export interface NodeInspectorResult {
  label: string
  lines: string[]
}

export type NodeInspector = (node: SpecNode) => NodeInspectorResult

/**
 * A specification package: a composable semantic compiler extension that
 * encapsulates domain abstractions, constraints, capabilities, validation
 * and lowering rules.
 */
export interface SpecPackage {
  name: string
  version: string
  nodeKinds?: NodeKindDefinition[]
  capabilities?: CapabilityDefinition[]
  validators?: SpecValidator[]
  lowerings?: SpecLowering[]
  /** Deterministic target guidance and dependency pins owned by the package. */
  generation?: GenerationContribution[]
  /** Optional per-node-kind rendering hooks used by `spec inspect`. */
  inspectors?: Record<string, NodeInspector>
  metadata?: Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/* Agent architecture preparation (interfaces only — no MVP runtime)   */
/* ------------------------------------------------------------------ */

export interface AgentTask {
  id: string
  type: string
  input: unknown
  constraints: Constraint[]
  context: {
    specNodeIds: string[]
  }
}

export type ArtifactType = "source" | "config" | "test" | "document" | "verification"

export interface Artifact {
  id: string
  type: ArtifactType
  path?: string
  contentHash?: string
  generatedBy?: string
  sourceNodes?: string[]
}

export interface AgentResult {
  taskId: string
  status: "success" | "failure"
  artifacts?: Artifact[]
  diagnostics?: Diagnostic[]
}

/* ------------------------------------------------------------------ */
/* GitHub-native execution of compiler-owned agent DAGs               */
/* ------------------------------------------------------------------ */

/** Reproducible executor contract shared by every task in one run. */
export interface AgentExecutionEnvironment {
  /** Immutable OCI image reference (`repository@sha256:...`). */
  image: string
  /** Hash of the repository-owned devcontainer/environment definition. */
  devcontainerHash: string
  /** Hash covering language and package-manager lockfiles. */
  toolchainLockHash: string
}

/** Clean-container acceptance gate re-run against the pushed commit. */
export interface AgentExecutionAcceptance {
  requiredChecks: string[]
  commands: string[]
}

/**
 * Plan-time node. Its integration base does not exist until all dependency
 * head SHAs have been published, so it intentionally contains no baseSha.
 */
export interface AgentExecutionTask {
  id: string
  objective: string
  instruction: string
  /** Agent tasks are written by the coding agent; materialize tasks contain compiler-owned bytes. */
  executor?: "agent" | "materialize"
  materializedFiles?: Record<string, string>
  dependsOn: string[]
  /** Task commands and relative prompt paths resolve from here. */
  workingDirectory?: string
  /** Exact repository-relative file paths; glob semantics are not implicit. */
  scope: string[]
  specNodeIds: string[]
  acceptance?: AgentExecutionAcceptance
}

export type AgentExecutionMergePolicy = "pull-request" | "merge-queue"

/** Byte-stable execution envelope for one compiler-owned agent DAG. */
export interface AgentExecutionPlan {
  schemaVersion: "spec-agent-execution-plan/0.1"
  graphKind: "generation-execution"
  runId: string
  repository: string
  defaultBranch: string
  /** Immutable root Git commit from which the run is reproducible. */
  rootBaseSha: string
  branchPrefix: string
  environment: AgentExecutionEnvironment
  acceptance: AgentExecutionAcceptance
  mergePolicy: AgentExecutionMergePolicy
  tasks: AgentExecutionTask[]
  fingerprint: string
}

/** Ready-time task whose dependency commits and integration base are known. */
export interface ResolvedAgentExecutionTask extends AgentExecutionTask {
  runId: string
  repository: string
  baseSha: string
  dependencyHeadShas: Record<string, string>
  baseRef: string
  branch: string
  environment: AgentExecutionEnvironment
  acceptance: AgentExecutionAcceptance
}

export type AgentExecutionTaskStatus =
  | "planned"
  | "running"
  | "pushed"
  | "checking"
  | "review"
  | "merged"
  | "failure"

export interface AgentExecutionCheckResult {
  name: string
  status: "queued" | "in_progress" | "success" | "failure"
  url?: string
}

/** GitHub-backed runtime state. It does not mutate the task definition. */
export interface AgentExecutionTaskResult {
  taskId: string
  status: AgentExecutionTaskStatus
  branch?: string
  integrationBaseSha?: string
  headSha?: string
  pullRequest?: { number: number; url: string }
  checks: AgentExecutionCheckResult[]
  startedAt?: string
  completedAt?: string
  costUsd?: number
  diagnostics?: Diagnostic[]
}
