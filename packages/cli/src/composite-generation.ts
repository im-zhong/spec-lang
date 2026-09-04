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

function boundHttpOperations(
  module: SpecModuleDefinition,
  definitions: Map<string, SpecInterfaceDefinition>,
): Record<string, Record<string, unknown>> {
  const operations: Record<string, Record<string, unknown>> = {}
  for (const call of module.calls) {
    const definition = definitions.get(call.interfaceId)
    if (!definition) continue
    const selected = selectedOperations(module, definition)
    requireHttpTransport(module, definition, selected)
    if (definition.protocol !== "http-json") continue
    operations[definition.name] = Object.fromEntries(selected.map((name) => [name, definition.operations[name]]))
  }
  return operations
}

function reactInterfaceClient(
  module: SpecModuleDefinition,
  definitions: Map<string, SpecInterfaceDefinition>,
): string | undefined {
  const operations = boundHttpOperations(module, definitions)
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

function pythonInterfaceClient(
  module: SpecModuleDefinition,
  definitions: Map<string, SpecInterfaceDefinition>,
): string | undefined {
  const operations = boundHttpOperations(module, definitions)
  if (Object.keys(operations).length === 0) return undefined
  const encoded = JSON.stringify(stableStringify(operations))
  return [
    '"""Compiler-owned HTTP interface client. DO NOT EDIT."""',
    "from __future__ import annotations",
    "",
    "import json",
    "import re",
    "from urllib.error import HTTPError",
    "from urllib.parse import urlencode",
    "from urllib.request import Request, urlopen",
    "from typing import Any",
    "",
    `SPEC_INTERFACE_OPERATIONS: dict[str, dict[str, dict[str, Any]]] = json.loads(${encoded})`,
    "",
    "class InterfaceCallError(RuntimeError):",
    "    def __init__(self, status: int, body: Any) -> None:",
    "        super().__init__(f\"Interface call failed: {status}\")",
    "        self.status = status",
    "        self.body = body",
    "",
    "def call_spec_interface(",
    "    interface_name: str,",
    "    operation: str,",
    "    *,",
    "    base_url: str,",
    "    input: dict[str, Any] | None = None,",
    "    timeout: float = 5.0,",
    ") -> Any:",
    "    try:",
    "        descriptor = SPEC_INTERFACE_OPERATIONS[interface_name][operation]",
    "    except KeyError as error:",
    "        raise KeyError(f\"Unknown interface operation: {interface_name}.{operation}\") from error",
    "    values = dict(input or {})",
    "    consumed: set[str] = set()",
    "",
    "    def replace(match: re.Match[str]) -> str:",
    "        from urllib.parse import quote",
    "        name = match.group(1)",
    "        if name not in values:",
    "            raise ValueError(f\"Missing path input: {name}\")",
    "        consumed.add(name)",
    "        return quote(str(values[name]), safe=\"\")",
    "",
    "    transport = descriptor[\"transport\"]",
    "    method = str(transport[\"method\"])",
    "    path = re.sub(r\"\\{([^}]+)\\}\", replace, str(transport[\"path\"]))",
    "    remaining = {key: value for key, value in values.items() if key not in consumed}",
    "    url = base_url.rstrip(\"/\") + path",
    "    data: bytes | None = None",
    "    headers: dict[str, str] = {}",
    "    if method == \"GET\" and remaining:",
    "        url += \"?\" + urlencode(remaining, doseq=True)",
    "    elif method != \"GET\":",
    "        data = json.dumps(remaining, separators=(\",\", \":\"), sort_keys=True).encode()",
    "        headers[\"content-type\"] = \"application/json\"",
    "    request = Request(url, data=data, headers=headers, method=method)",
    "    try:",
    "        with urlopen(request, timeout=timeout) as response:",
    "            payload = response.read()",
    "            return None if response.status == 204 else json.loads(payload)",
    "    except HTTPError as error:",
    "        payload = error.read()",
    "        try:",
    "            body: Any = json.loads(payload)",
    "        except (json.JSONDecodeError, UnicodeDecodeError):",
    "            body = payload.decode(errors=\"replace\")",
    "        raise InterfaceCallError(error.code, body) from error",
    "",
  ].join("\n")
}

interface EntityFieldSample {
  default?: unknown
  states?: string[]
}

function sampleForType(type: string, field: string, declared?: EntityFieldSample): unknown {
  if (type === "int") return 7
  if (type === "boolean") return true
  if (type === "uuid" || type === "ref") return "00000000-0000-4000-8000-000000000001"
  if (type === "email") return "interface@example.com"
  if (type === "datetime") return "2026-01-01T12:00:00"
  if (type === "enum") {
    // The seeded create must satisfy the provider's own validation, so an
    // enum field needs one of its declared states — never a placeholder.
    if (declared?.default !== undefined) return declared.default
    if (declared?.states?.length) return declared.states[0]
    throw new Error(`cannot seed interface setup: enum field "${field}" declares no states`)
  }
  return `interface-${field}`
}

function entityFieldSamples(ir: SpecIR): Map<string, Record<string, EntityFieldSample>> {
  return new Map(
    ir.nodes
      .filter((node) => node.kind === "entity")
      .map((node) => {
        const fields = (node.attributes.fields ?? {}) as Record<string, EntityFieldSample>
        return [String(node.name), fields]
      }),
  )
}

interface CrossInterfaceCase {
  provider: string
  consumer: string
  interfaceName: string
  interfaceHash: string
  operation: string
  output: unknown
  setup?: { method: string; path: string; body: Record<string, unknown> }
}

function crossInterfaceCases(
  ir: SpecIR,
  directories: Map<string, string>,
  blueprints: Record<string, unknown>,
): CrossInterfaceCase[] {
  const definitions = new Map(ir.interfaces.definitions.map((item) => [item.id, item]))
  const modules = new Map(ir.modules.map((item) => [item.id, item]))
  const entities = entityFieldSamples(ir)
  const cases: CrossInterfaceCase[] = []
  for (const dependency of ir.interfaces.dependencies) {
    const provider = modules.get(dependency.providerModuleId)
    const consumer = modules.get(dependency.consumerModuleId)
    const definition = definitions.get(dependency.interfaceId)
    if (!provider || !consumer || !definition || definition.protocol !== "http-json") continue
    if (provider.target !== "fastapi" || consumer.target !== "fastapi") continue
    const providerDirectory = directories.get(provider.id)!
    const consumerDirectory = directories.get(consumer.id)!
    const blueprint = blueprints[providerDirectory] as FastApiGenerationPlan["blueprint"]
    for (const operationName of dependency.operations.length > 0
      ? dependency.operations
      : Object.keys(definition.operations).sort()) {
      const operation = definition.operations[operationName]
      const transport = operation.transport!
      const route = blueprint.routes.find((item) => item.method === transport.method && item.path === transport.path)
      let setup: CrossInterfaceCase["setup"]
      if (route?.response.kind === "entityArray" && route.entity) {
        const create = blueprint.routes.find((item) => item.operation === "create" && item.entity === route.entity)
        if (create?.request) {
          const entityFields = entities.get(String(route.entity)) ?? {}
          setup = {
            method: create.method,
            path: create.path,
            body: Object.fromEntries(
              Object.entries(create.request.shape).map(([field, type]) => [field, sampleForType(type, field, entityFields[field])]),
            ),
          }
        }
      }
      cases.push({
        provider: providerDirectory,
        consumer: consumerDirectory,
        interfaceName: definition.name,
        interfaceHash: definition.hash,
        operation: operationName,
        output: operation.output,
        ...(setup ? { setup } : {}),
      })
    }
  }
  return cases.sort((a, b) => `${a.provider}\0${a.consumer}\0${a.interfaceName}\0${a.operation}`.localeCompare(`${b.provider}\0${b.consumer}\0${b.interfaceName}\0${b.operation}`))
}

function crossInterfaceOracle(cases: CrossInterfaceCase[]): string {
  const encoded = JSON.stringify(stableStringify(cases))
  return [
    '"""Compiler-owned live cross-module interface oracle. DO NOT EDIT."""',
    "from __future__ import annotations",
    "",
    "import importlib.util",
    "import json",
    "import os",
    "import socket",
    "import subprocess",
    "import tempfile",
    "import time",
    "from pathlib import Path",
    "from urllib.request import Request, urlopen",
    "",
    `CASES = json.loads(${encoded})`,
    "ROOT = Path(__file__).resolve().parents[1]",
    "",
    "def free_port() -> int:",
    "    with socket.socket() as sock:",
    "        sock.bind((\"127.0.0.1\", 0))",
    "        return int(sock.getsockname()[1])",
    "",
    "def wait_ready(port: int) -> None:",
    "    deadline = time.monotonic() + 15",
    "    while time.monotonic() < deadline:",
    "        try:",
    "            with socket.create_connection((\"127.0.0.1\", port), timeout=0.2):",
    "                return",
    "        except OSError:",
    "            time.sleep(0.05)",
    "    raise AssertionError(\"provider did not become ready\")",
    "",
    "def assert_shape(value: object, shape: object) -> None:",
    "    if isinstance(shape, list):",
    "        assert isinstance(value, list)",
    "        if shape:",
    "            for item in value:",
    "                assert_shape(item, shape[0])",
    "        return",
    "    if isinstance(shape, dict):",
    "        assert isinstance(value, dict)",
    "        assert set(value) == set(shape)",
    "        for key, child in shape.items():",
    "            assert_shape(value[key], child)",
    "        return",
    "    if shape in (\"uuid\", \"string\", \"email\", \"datetime\"):",
    "        assert isinstance(value, str)",
    "    elif shape == \"int\":",
    "        assert isinstance(value, int) and not isinstance(value, bool)",
    "    elif shape == \"boolean\":",
    "        assert isinstance(value, bool)",
    "",
    "def request_json(base_url: str, method: str, path: str, body: object) -> object:",
    "    data = json.dumps(body, separators=(\",\", \":\"), sort_keys=True).encode()",
    "    request = Request(base_url + path, data=data, headers={\"content-type\": \"application/json\"}, method=method)",
    "    with urlopen(request, timeout=5) as response:",
    "        assert response.status in (200, 201)",
    "        return json.loads(response.read())",
    "",
    "def load_client(directory: str):",
    "    path = ROOT / directory / \"app\" / \"spec_interface_client.py\"",
    "    spec = importlib.util.spec_from_file_location(f\"spec_interface_client_{directory}\", path)",
    "    assert spec and spec.loader",
    "    module = importlib.util.module_from_spec(spec)",
    "    spec.loader.exec_module(module)",
    "    return module",
    "",
    "def main() -> None:",
    "    evidence = []",
    "    for index, case in enumerate(CASES):",
    "        provider = ROOT / case[\"provider\"]",
    "        port = free_port()",
    "        base_url = f\"http://127.0.0.1:{port}\"",
    "        with tempfile.TemporaryDirectory(prefix=\"spec-interface-\") as temporary:",
    "            environment = dict(os.environ)",
    "            environment[\"DATABASE_URL\"] = f\"sqlite:///{temporary}/interface.db\"",
    "            process = subprocess.Popen(",
    "                [str(provider / \".venv\" / \"bin\" / \"python\"), \"-m\", \"uvicorn\", \"app.main:app\", \"--host\", \"127.0.0.1\", \"--port\", str(port), \"--log-level\", \"warning\"],",
    "                cwd=provider, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,",
    "            )",
    "            try:",
    "                wait_ready(port)",
    "                if case.get(\"setup\"):",
    "                    setup = case[\"setup\"]",
    "                    request_json(base_url, setup[\"method\"], setup[\"path\"], setup[\"body\"])",
    "                client = load_client(case[\"consumer\"])",
    "                value = client.call_spec_interface(case[\"interfaceName\"], case[\"operation\"], base_url=base_url)",
    "                assert_shape(value, case[\"output\"])",
    "                evidence.append({key: case[key] for key in (\"provider\", \"consumer\", \"interfaceName\", \"interfaceHash\", \"operation\")})",
    "            finally:",
    "                process.terminate()",
    "                try:",
    "                    process.wait(timeout=5)",
    "                except subprocess.TimeoutExpired:",
    "                    process.kill()",
    "                    process.wait(timeout=5)",
    "    print(json.dumps(evidence, separators=(\",\", \":\"), sort_keys=True))",
    "",
    "if __name__ == \"__main__\":",
    "    main()",
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
  const moduleDirectories = new Map(ir.modules.map((module) => [module.id, directoryName(module)]))

  for (const module of [...ir.modules].sort((a, b) => a.id.localeCompare(b.id))) {
    const directory = directoryName(module)
    const lowered = lowerModule(ir, module)
    blueprints[directory] = lowered.blueprint
    if (module.target === "fastapi") assertProviderRoutes(module, definitions, lowered as FastApiGenerationPlan)
    const reactClient = module.target === "react" ? reactInterfaceClient(module, definitions) : undefined
    if (reactClient) seedFiles[`${directory}/src/spec-interface-client.ts`] = reactClient
    const pythonClient = module.target === "fastapi" ? pythonInterfaceClient(module, definitions) : undefined
    if (pythonClient) seedFiles[`${directory}/app/spec_interface_client.py`] = pythonClient
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

  const interfaceCases = crossInterfaceCases(ir, moduleDirectories, blueprints)
  if (interfaceCases.length > 0) {
    const interpreter = `${interfaceCases[0].consumer}/.venv/bin/python`
    conformanceFiles[".spec-interfaces/test_contracts.py"] = crossInterfaceOracle(interfaceCases)
    evidenceFiles.push("conformance-output/interfaces.json")
    check.push({
      name: "interfaces:live-contracts",
      command: `mkdir -p conformance-output && ${interpreter} .spec-interfaces/test_contracts.py > conformance-output/interfaces.json`,
      timeoutMs: 120_000,
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
