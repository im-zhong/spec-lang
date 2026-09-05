export { fastapi, FASTAPI_REQUIRES, type FastApiInput, type FastApiStackInput } from "./builder"
export {
  buildBlueprint,
  snakeCase,
  DEFAULT_FASTAPI_STACK,
  resolveStack,
  type BackendBlueprint,
  type BackendStack,
  type BlueprintEntity,
  type BlueprintField,
  type BlueprintRoute,
  type BlueprintProviderRef,
  type BlueprintCache,
  type BlueprintMessage,
  type BlueprintQueue,
  type BlueprintBlob,
  type RouteOperation,
  type HttpMethod,
} from "./blueprint"
export { buildConformanceSuite, type ConformanceFiles } from "./conformance"
export {
  buildTaskDag,
  dagFingerprint,
  topologicalSort,
  type GenerationDag,
  type DagTask,
} from "./dag"
export { deriveClauses, clausesByTask } from "./clauses"
export { buildNodeOracles, testCommandFor, oracleFileFor, ORACLE_DIR } from "./oracle"
export {
  planGeneration,
  type FastApiGenerationPlan,
} from "./lowering"
export {
  projectPrompt,
  modelsPrompt,
  databasePrompt,
  schemasPrompt,
  securityPrompt,
  routerPrompt,
  authRouterPrompt,
  appPrompt,
  cachePrompt,
  messagingPrompt,
  blobPrompt,
  type TaskPromptInput,
} from "./prompt"
export { fastApiVerification, type VerificationPlan, type VerificationCommand } from "./verify"
export { default as fastApiPackage } from "./spec-package"
export { deriveTestManifest, coverageDiagnostics, type TestManifest, type CoverageEntry } from "./manifest"
