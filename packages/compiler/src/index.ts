export { compile, writeArtifacts } from "./compiler"
export type { CompileResult, CompilerOptions, CompilerContext, CompilerPass, WrittenArtifacts } from "./compiler"
export { renderSpecTree } from "./inspect"
export { loadSpecConfig, DEFAULT_CONFIG } from "./config"
export type { SpecConfig } from "./config"
export { stableStringify } from "./stable"
export { COMPILER_VERSION, SPEC_VERSION } from "./version"
export type { SpecManifest } from "./pipeline"
export { planIncrementalGeneration, planInterfaceModuleGeneration, sliceIrForModule } from "./incremental"
export type {
  IncrementalGenerationPlan,
  IncrementalModuleDecision,
  InterfaceModuleGenerationDag,
  InterfaceModuleGenerationTask,
} from "./incremental"
