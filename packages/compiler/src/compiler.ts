/**
 * Compiler orchestration: the explicit pass pipeline and the public API.
 *
 *   Parse -> Resolve -> Normalize -> Validate -> Link -> Lower -> Emit
 *
 * Every pass is a CompilerPass; the pipeline is extensible for future
 * agentic / verification passes without touching this file's callers.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import type { Diagnostic, Logger, SpecIR, SpecPackage } from "@spec/core"
import { InternalCompilerError, silentLogger } from "@spec/core"
import { sortDiagnostics } from "./diagnostics"
import { displayPath } from "./parse"
import { DEFAULT_CONFIG, loadSpecConfig } from "./config"
import {
  buildManifest,
  emitPass,
  linkPass,
  lowerPass,
  normalizePass,
  parsePass,
  resolvePass,
  validatePass,
  type Compilation,
  type SpecManifest,
} from "./pipeline"
import { stableStringify } from "./stable"
import type { LoadedSpecPackage } from "./loader"

export interface CompilerOptions {
  projectRoot?: string
  outputDir?: string
  logger?: Logger
}

/** Shared compiler context (spec §28). */
export interface CompilerContext {
  projectRoot: string
  packages: Map<string, SpecPackage>
  diagnostics: Diagnostic[]
  options: CompilerOptions
}

export interface CompilerPass<Input, Output> {
  name: string
  run(input: Input, context: CompilerContext): Promise<Output>
}

export interface CompileResult {
  /** True when no error-level diagnostics were produced. */
  ok: boolean
  ir: SpecIR
  manifest: SpecManifest
  diagnostics: Diagnostic[]
  loadedPackages: LoadedSpecPackage[]
  outputDir: string
}

export interface WrittenArtifacts {
  irPath: string
  manifestPath: string
  diagnosticsPath: string
}

function makeContext(options: CompilerOptions): CompilerContext {
  return {
    projectRoot: options.projectRoot ?? process.cwd(),
    packages: new Map(),
    diagnostics: [],
    options,
  }
}

/** Compile a `.spec.ts` entry file to a Spec IR result (no files written). */
export async function compile(entry: string, options: CompilerOptions = {}): Promise<CompileResult> {
  const logger = options.logger ?? silentLogger
  const context = makeContext(options)
  const absoluteEntry = path.resolve(context.projectRoot, entry)

  const compilation: Compilation = {
    entry: entry.replace(/\\/g, "/"),
    entryPath: absoluteEntry,
    loadedPackages: [],
    nodes: [],
    capabilities: { required: [], provided: [] },
    diagnostics: [],
  }

  if (!fs.existsSync(absoluteEntry)) {
    compilation.diagnostics.push({
      code: "SPEC_ENTRY_NOT_FOUND",
      level: "error",
      message: `Specification file not found: ${entry}`,
    })
    compilation.ir = {
      version: "spec-ir/0.1",
      app: { name: "unknown" },
      packages: [],
      nodes: [],
      capabilities: { required: [], provided: [] },
      diagnostics: compilation.diagnostics,
      metadata: { compilerVersion: "0.1.0" },
    }
    return finish(compilation, context, options)
  }
  compilation.entry = displayPath(absoluteEntry, context.projectRoot)

  const passes: Array<CompilerPass<Compilation, Compilation>> = [
    { name: "parse", run: async (c) => parsePass(c) },
    { name: "resolve", run: async (c) => resolvePass(c) },
    { name: "normalize", run: async (c) => normalizePass(c) },
    { name: "validate", run: async (c) => validatePass(c) },
    { name: "link", run: async (c) => linkPass(c) },
    { name: "lower", run: async (c) => lowerPass(c) },
    { name: "emit", run: async (c) => emitPass(c) },
  ]

  for (const pass of passes) {
    logger.debug(`pass ${pass.name} start`)
    await pass.run(compilation, context)
    logger.debug(`pass ${pass.name} done`, { diagnostics: compilation.diagnostics.length })
  }

  // Register package definitions on the context for downstream tooling.
  for (const pkg of compilation.loadedPackages) context.packages.set(pkg.name, pkg.definition)
  context.diagnostics.push(...compilation.diagnostics)

  if (!compilation.ir) {
    throw new InternalCompilerError("emit pass produced no IR", {
      entry: compilation.entry,
    })
  }

  return finish(compilation, context, options)
}

function finish(
  compilation: Compilation,
  context: CompilerContext,
  options: CompilerOptions,
): CompileResult {
  const diagnostics = sortDiagnostics(compilation.diagnostics)
  const ir: SpecIR = compilation.ir ?? {
    version: "spec-ir/0.1",
    app: { name: "unknown" },
    packages: [],
    nodes: compilation.nodes,
    capabilities: compilation.capabilities,
    diagnostics,
    metadata: { compilerVersion: "0.1.0" },
  }
  ir.diagnostics = diagnostics
  const config = options.outputDir
    ? { outputDir: options.outputDir }
    : loadSpecConfig(context.projectRoot) ?? DEFAULT_CONFIG
  return {
    ok: !diagnostics.some((d) => d.level === "error"),
    ir,
    manifest: buildManifest(compilation),
    diagnostics,
    loadedPackages: compilation.loadedPackages,
    outputDir: config.outputDir,
  }
}

/** Write deterministic build artifacts (spec.ir.json, manifest.json, diagnostics.json). */
export async function writeArtifacts(
  result: CompileResult,
  projectRoot: string,
): Promise<WrittenArtifacts> {
  const outDir = path.resolve(projectRoot, result.outputDir)
  fs.mkdirSync(outDir, { recursive: true })
  const irPath = path.join(outDir, "spec.ir.json")
  const manifestPath = path.join(outDir, "manifest.json")
  const diagnosticsPath = path.join(outDir, "diagnostics.json")
  fs.writeFileSync(irPath, stableStringify(result.ir) + "\n", "utf8")
  fs.writeFileSync(manifestPath, stableStringify(result.manifest) + "\n", "utf8")
  fs.writeFileSync(diagnosticsPath, stableStringify(result.diagnostics) + "\n", "utf8")
  return { irPath, manifestPath, diagnosticsPath }
}
