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

/** A named, language-neutral operation contract shared across generation targets. */
export interface SpecInterfaceOperation {
  input?: unknown
  output: unknown
  errors?: Record<string, unknown>
  /** Concrete invocation ABI for the protocol, independent of either implementation. */
  transport?: {
    method: string
    path: string
  }
}

/** Canonical interface definition. `hash` covers protocol/version/operations only. */
export interface SpecInterfaceDefinition {
  id: string
  name: string
  protocol: string
  version: string
  operations: Record<string, SpecInterfaceOperation>
  hash: string
  sourceNodeId: string
}

export interface SpecInterfaceBinding {
  moduleId: string
  interfaceId: string
  role: "provides" | "calls"
  /** Empty means every operation in the interface. */
  operations: string[]
}

/**
 * An interface dependency is an invalidation edge, not a generation-order
 * edge: provider and consumer can be generated in parallel from the same
 * frozen definition.
 */
export interface SpecInterfaceDependency {
  providerModuleId: string
  consumerModuleId: string
  interfaceId: string
  interfaceHash: string
  operations: string[]
}

export interface SpecModuleDefinition {
  id: string
  name: string
  target: string
  sourceNodeId: string
  provides: string[]
  calls: Array<{ interfaceId: string; operations: string[] }>
  contains: string[]
  /** Hash of the module declaration plus every provided/called interface. */
  inputHash: string
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
  interfaces: {
    definitions: SpecInterfaceDefinition[]
    bindings: SpecInterfaceBinding[]
    dependencies: SpecInterfaceDependency[]
  }
  modules: SpecModuleDefinition[]
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

export const SPEC_IR_VERSION = "spec-ir/0.3"

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

/* ------------------------------------------------------------------ */
/* Clause tables — the machine-addressable node contract              */
/* ------------------------------------------------------------------ */

/** How a clause is mechanically judged during generation. */
export type ClauseVerification = "oracle" | "lint" | "review"

/** api = observable on the node's public surface; function = internal semantics. */
export type ClauseLevel = "api" | "function"

/**
 * One machine-addressable obligation of one generation node. The clause
 * table is the single source of truth a node's prompt kernel, its
 * compiler-generated oracle, and its reviewer checklist all project from.
 */
export interface ContractClause {
  /** Deterministic identifier derived from stable blueprint identifiers. */
  id: string
  /** Single-sentence imperative rendered verbatim by every projection. */
  statement: string
  /** Owning generation node id, e.g. "router:Booking". */
  node: string
  /** Target-scoped taxonomy, e.g. route/error/abi/import/pin/column/invariant/transition/serialization/adapter/file. */
  kind: string
  verification: ClauseVerification
  level: ClauseLevel
}

/** Byte-stable clause table stamped for one generation node. */
export interface NodeClauseTable {
  schemaVersion: "spec-clause-table/0.1"
  node: string
  clauses: ContractClause[]
}


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
  /**
   * Immutable OCI image reference (`repository@sha256:...`). Required
   * whenever the agent runs in Docker or checks run on GitHub Actions
   * (both pull it); a pure `--execution local --runtime host` run never
   * touches a container, so it may omit the image entirely.
   */
  image?: string
  /**
   * Where the agent and acceptance commands execute. Omitted means
   * "docker" (the original execution model), which keeps older plans valid.
   */
  runtime?: "docker" | "host"
  /**
   * Which durable-branch control plane verifies and lands task heads.
   * Omitted means "github", preserving older plans.
   */
  controlPlane?: "github" | "local"
  /** Hash of the repository-owned devcontainer/environment definition. */
  devcontainerHash: string
  /** Hash covering language and package-manager lockfiles. */
  toolchainLockHash: string
  /** Frozen coding-agent settings that can affect generated output. */
  agent: {
    /** Explicit Claude model override; omitted means use the CLI's default model. */
    model?: string
    effort: "low" | "medium" | "high" | "xhigh" | "max"
    maxTurns: number
    /** Maximum agent containers scheduled concurrently inside this shot. */
    maxConcurrency: number
  }
}

/** Clean-container acceptance gate re-run against the pushed commit. */
export interface AgentExecutionAcceptance {
  requiredChecks: string[]
  commands: string[]
}

export interface AgentExecutionLoopWorker {
  instruction: string
  /** Exact subset of the outer task scope owned by this writer. */
  scope: string[]
}

export interface AgentExecutionLoopReviewer {
  instruction: string
  commands: string[]
  /** Frozen compiler-owned oracle files the commands execute (agent-unwritable). */
  oracleFiles?: string[]
  /** Structured checklist projected from the node's clause table. */
  clauses?: ContractClause[]
}

/**
 * Pre-conformance synthesis loop for one DAG node. A single implementation
 * agent works against the frozen clause table while compiler-generated
 * oracle tests stay materialized and uneditable; a read-only reviewer
 * judges the machine evidence plus the review-kind clauses and either
 * approves or returns feedback for the next bounded round. This is never
 * a conformance-repair loop.
 */
export interface AgentExecutionLoop {
  schemaVersion: "spec-agent-task-loop/0.2"
  maxRounds: number
  implementation: AgentExecutionLoopWorker
  reviewer: AgentExecutionLoopReviewer
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
  loop?: AgentExecutionLoop
  acceptance?: AgentExecutionAcceptance
}

/**
 * How a fully checked task head lands on the default branch.
 *
 * - "pull-request": task branches stay PRs; a human merges the sink PR.
 * - "merge-queue": the sink PR enters GitHub's merge queue.
 * - "merge-to-main": the team model — every feature-node branch runs its own
 *   internal acceptance, then deterministic code (merge-tree + commit-tree)
 *   merges it into the default branch. The compiler's scope partition is the
 *   guarantee that those merges never conflict; a conflict is a contract
 *   defect and fails loud.
 */
export type AgentExecutionMergePolicy = "pull-request" | "merge-queue" | "merge-to-main"

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
  /** Shot-independent hash of frozen prompts, oracle, environment and task semantics. */
  semanticInputDigest: string
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
  /** Default-branch head produced by the deterministic merge-to-main integration. */
  mergedSha?: string
  pullRequest?: { number: number; url: string }
  checks: AgentExecutionCheckResult[]
  startedAt?: string
  completedAt?: string
  costUsd?: number
  diagnostics?: Diagnostic[]
}
