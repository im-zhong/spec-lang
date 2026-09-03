import { createHash } from "node:crypto"
import type { SpecIR, SpecInterfaceDefinition, SpecModuleDefinition } from "@spec/core"
import { stableStringify, sliceIrForModule } from "@spec/compiler"
import { planGeneration, type FastApiGenerationPlan } from "@spec/fastapi"
import { planFrontendGeneration, type FrontendGenerationPlan } from "@spec/react"
import { OPENAPI_SNIPPET, type HarnessTask, type ShotSpec, type VerificationCommand } from "@spec/agent"

export interface CompositeModulePlan {
  moduleId: string
  name: string
  target: "fastapi" | "react"
  directory: string
  inputHash: string
  interfaceHashes: string[]
  taskIds: string[]
}

export interface CompositeGenerationPlan {
  schemaVersion: "spec-composite-generation-plan/0.1"
  modules: CompositeModulePlan[]
  interfaceContract: {
    schemaVersion: "spec-interface-contracts/0.1"
    definitions: SpecInterfaceDefinition[]
  }
  /** Complete per-target blueprints, keyed by the isolated module directory. */
  blueprints: Record<string, unknown>
  shot: ShotSpec
  /** Stable compiler input persisted in the content-addressed semantic bundle. */
  stable: string
}

function directoryName(module: SpecModuleDefinition): string {
  const value = module.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  if (!value) throw new Error(`module ${module.id} cannot form a safe generation directory`)
  return value
}

function prefixFiles(directory: string, files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([file, content]) => [`${directory}/${file}`, content]))
}

function prefixTask(module: SpecModuleDefinition, directory: string, task: HarnessTask, contract: string): HarnessTask {
  const id = `${directory}:${task.id}`
  const prefix = (file: string) => `${directory}/${file}`
  return {
    ...task,
    id,
    label: `${module.name}: ${task.label ?? task.id}`,
    dependsOn: task.dependsOn.map((dependency) => `${directory}:${dependency}`),
    workingDirectory: directory,
    scope: task.scope.map(prefix),
    prompt: `${task.prompt}\n\n# Frozen cross-module interface contract\n${contract}\nImplement only this module. Other modules are generated independently and are unavailable except through this contract.`,
    ...(task.loop ? {
      loop: {
        ...task.loop,
        implementation: { ...task.loop.implementation, scope: task.loop.implementation.scope.map(prefix) },
        tests: { ...task.loop.tests, scope: task.loop.tests.scope.map(prefix) },
      },
    } : {}),
  }
}

function inDirectory(directory: string, command: string): string {
  return `cd '${directory.replace(/'/g, `'\\''`)}' && ${command}`
}

function prefixCommands(directory: string, commands: VerificationCommand[]): VerificationCommand[] {
  return commands.map((command) => ({
    ...command,
    name: `${directory}:${command.name}`,
    command: inDirectory(directory, command.command),
  }))
}

function lowerModule(ir: SpecIR, module: SpecModuleDefinition): FastApiGenerationPlan | FrontendGenerationPlan {
  const sliced = sliceIrForModule(ir, module)
  try {
    if (module.target === "fastapi") return planGeneration(sliced)
    if (module.target === "react") return planFrontendGeneration(sliced)
  } catch (error) {
    throw new Error(`cannot lower module ${module.id} (${module.target}): ${error instanceof Error ? error.message : String(error)}`)
  }
  throw new Error(`module ${module.id} uses unsupported generation target "${module.target}"; supported targets are fastapi and react`)
}

function selectedOperations(module: SpecModuleDefinition, definition: SpecInterfaceDefinition): string[] {
  const call = module.calls.find((item) => item.interfaceId === definition.id)
  return call && call.operations.length > 0 ? call.operations : Object.keys(definition.operations).sort()
}

function requireHttpTransport(module: SpecModuleDefinition, definition: SpecInterfaceDefinition, operations: string[]): void {
  if (definition.protocol !== "http-json") return
  for (const name of operations) {
    const transport = definition.operations[name]?.transport
    if (!transport || !/^[A-Z]+$/.test(transport.method) || !transport.path.startsWith("/")) {
      throw new Error(
        `module ${module.id} binds HTTP interface operation ${definition.name}.${name} without a valid transport { method, path }`,
      )
    }
  }
}

function assertProviderRoutes(
  module: SpecModuleDefinition,
  definitions: Map<string, SpecInterfaceDefinition>,
  plan: FastApiGenerationPlan,
): void {
  const routes = new Set(plan.blueprint.routes.map((route) => `${route.method} ${route.path}`))
  for (const id of module.provides) {
    const definition = definitions.get(id)
    if (!definition) continue
    const operations = Object.keys(definition.operations).sort()
    requireHttpTransport(module, definition, operations)
    if (definition.protocol !== "http-json") continue
    for (const name of operations) {
      const transport = definition.operations[name].transport!
      const route = `${transport.method} ${transport.path}`
      if (!routes.has(route)) {
        throw new Error(
          `module ${module.id} claims to provide ${definition.name}.${name} at ${route}, but its FastAPI blueprint exposes no such route`,
        )
      }
    }
  }
}

function interfaceClient(
  module: SpecModuleDefinition,
  definitions: Map<string, SpecInterfaceDefinition>,
): string | undefined {
  const operations: Record<string, Record<string, unknown>> = {}
  for (const call of module.calls) {
    const definition = definitions.get(call.interfaceId)
    if (!definition) continue
    const selected = selectedOperations(module, definition)
    requireHttpTransport(module, definition, selected)
    if (definition.protocol !== "http-json") continue
    operations[definition.name] = Object.fromEntries(selected.map((name) => [name, definition.operations[name]]))
  }
  if (Object.keys(operations).length === 0) return undefined
  return [
    "// Compiler-owned interface client. DO NOT EDIT.",
    `export const SPEC_INTERFACE_OPERATIONS = ${stableStringify(operations)} as const`,
    "",
    "export async function callSpecInterface(interfaceName: string, operation: string, input: Record<string, unknown> = {}): Promise<unknown> {",
    "  const byInterface = SPEC_INTERFACE_OPERATIONS as Record<string, Record<string, { transport: { method: string; path: string } }>>",
    "  const descriptor = byInterface[interfaceName]?.[operation]",
    "  if (!descriptor) throw new Error(`Unknown interface operation: ${interfaceName}.${operation}`)",
    "  const consumed = new Set<string>()",
    "  const url = descriptor.transport.path.replace(/\\{([^}]+)\\}/g, (_match, name: string) => {",
    "    consumed.add(name)",
    "    if (!(name in input)) throw new Error(`Missing path input: ${name}`)",
    "    return encodeURIComponent(String(input[name]))",
    "  })",
    "  const rest = Object.fromEntries(Object.entries(input).filter(([name]) => !consumed.has(name)))",
    "  const query = descriptor.transport.method === 'GET' ? new URLSearchParams(Object.entries(rest).map(([key, value]) => [key, String(value)])).toString() : ''",
    "  const response = await fetch(query ? `${url}?${query}` : url, {",
    "    method: descriptor.transport.method,",
    "    headers: descriptor.transport.method === 'GET' ? undefined : { 'content-type': 'application/json' },",
    "    body: descriptor.transport.method === 'GET' ? undefined : JSON.stringify(rest),",
    "  })",
    "  if (!response.ok) throw new Error(`Interface call failed: ${response.status}`)",
    "  return response.status === 204 ? undefined : response.json()",
    "}",
    "",
  ].join("\n")
}

/**
 * Lower every module independently, then place the target DAGs beside one
 * another. There are no cross-module scheduling edges: the frozen interface
 * contract is the only shared input. A single final conformance node judges
 * every target once after all module DAGs have completed.
 */
export function planCompositeGeneration(ir: SpecIR): CompositeGenerationPlan {
  if (ir.modules.length === 0) throw new Error("composite generation requires at least one spec.module")
  const directories = ir.modules.map(directoryName)
  if (new Set(directories).size !== directories.length) {
    throw new Error("module names collide after generation-directory normalization")
  }
  const interfaceContract = {
    schemaVersion: "spec-interface-contracts/0.1" as const,
    definitions: [...ir.interfaces.definitions],
  }
  const contractJson = stableStringify(interfaceContract)
  const tasks: HarnessTask[] = []
  const seedFiles: Record<string, string> = {
    ".spec-interfaces/contracts.json": contractJson + "\n",
  }
  const conformanceFiles: Record<string, string> = {}
  const setup: VerificationCommand[] = []
  const check: VerificationCommand[] = []
  const evidenceFiles: string[] = []
  const evidenceCommands: VerificationCommand[] = []
  const modules: CompositeModulePlan[] = []
  const blueprints: Record<string, unknown> = {}
  const definitions = new Map(ir.interfaces.definitions.map((item) => [item.id, item]))

  for (const module of [...ir.modules].sort((a, b) => a.id.localeCompare(b.id))) {
    const directory = directoryName(module)
    const lowered = lowerModule(ir, module)
    blueprints[directory] = lowered.blueprint
    if (module.target === "fastapi") assertProviderRoutes(module, definitions, lowered as FastApiGenerationPlan)
    const client = module.target === "react" ? interfaceClient(module, definitions) : undefined
    if (client) seedFiles[`${directory}/src/spec-interface-client.ts`] = client
    const interfaceHashes = [...new Set([
      ...module.provides,
      ...module.calls.map((call) => call.interfaceId),
    ].map((id) => definitions.get(id)?.hash).filter((hash): hash is string => hash !== undefined))].sort()
    for (const task of lowered.dag.tasks) tasks.push(prefixTask(module, directory, task, contractJson))
    Object.assign(seedFiles, prefixFiles(directory, lowered.seedFiles))
    Object.assign(conformanceFiles, prefixFiles(directory, lowered.conformance.files))
    setup.push(...prefixCommands(directory, lowered.verification.setup))
    check.push(...prefixCommands(directory, lowered.verification.check))

    if (module.target === "fastapi") {
      evidenceFiles.push(`${directory}/conformance-output/openapi.json`, `${directory}/conformance-output/behavior.json`)
      evidenceCommands.push(
        {
          name: `${directory}:openapi-evidence`,
          command: inDirectory(directory, `mkdir -p conformance-output && .venv/bin/python -W ignore -c '${OPENAPI_SNIPPET.replace(/'/g, `'\\''`)}' > conformance-output/openapi.json`),
          timeoutMs: 120_000,
        },
        {
          name: `${directory}:behavior-evidence`,
          command: inDirectory(directory, ".venv/bin/python -W ignore conformance/behavior_snapshot.py > conformance-output/behavior.json"),
          timeoutMs: 120_000,
        },
      )
    } else {
      const frontend = lowered as FrontendGenerationPlan
      evidenceFiles.push(
        `${directory}/pnpm-lock.yaml`,
        ...frontend.blueprint.screens.map((_, index) => `${directory}/conformance-output/layout-${index}.png`),
        `${directory}/conformance-output/behavior.png`,
        `${directory}/conformance-output/behavior.json`,
      )
    }
    modules.push({
      moduleId: module.id,
      name: module.name,
      target: module.target as "fastapi" | "react",
      directory,
      inputHash: module.inputHash,
      interfaceHashes,
      taskIds: lowered.dag.tasks.map((task) => `${directory}:${task.id}`),
    })
  }

  const shot: ShotSpec = {
    tasks,
    seedFiles,
    conformanceFiles,
    conformanceDirs: modules.flatMap((module) => [`${module.directory}/conformance`, `${module.directory}/conformance-output`]),
    verification: { setup, check },
    generatedBy: "interface:composite-dag",
    evidenceFiles: evidenceFiles.sort(),
    evidenceCommands,
  }
  const stable = stableStringify({
    schemaVersion: "spec-composite-generation-plan/0.1",
    modules,
    interfaceContract,
    blueprints,
    shot,
  })
  return {
    schemaVersion: "spec-composite-generation-plan/0.1",
    modules,
    interfaceContract,
    blueprints,
    shot,
    stable,
  }
}

export function compositePlanDigest(plan: CompositeGenerationPlan): string {
  return createHash("sha256").update(plan.stable).digest("hex")
}
