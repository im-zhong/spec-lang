#!/usr/bin/env node
/**
 * spec — the specification compiler CLI.
 *
 * Commands:
 *   spec check <file>     parse + resolve + validate + link (no artifacts)
 *   spec build <file>     full compile, writes .spec/ artifacts
 *   spec inspect <file>   render a human-readable specification tree
 *   spec generate <file>  compile, then let a coding agent implement the
 *                         spec; verify against the compiler's conformance
 *                         suite; repeat N independent shots and require
 *                         identical behavior (the golden rule)
 *   spec generate-frontend <file>  same protocol for a React frontend,
 *                                  including Playwright visual equality
 *
 * Exit codes:
 *   0  success
 *   1  specification error / generation failed verification
 *   2  compiler / internal error (stack traces only with --debug)
 */
import * as path from "node:path"
import * as fs from "node:fs"
import { createHash } from "node:crypto"
import { compile, renderSpecTree, stableStringify, writeArtifacts, COMPILER_VERSION } from "@spec/compiler"
import { InternalCompilerError, createLogger, type Diagnostic } from "@spec/core"
import { planGeneration } from "@spec/fastapi"
import { planFrontendGeneration } from "@spec/react"
import { OPENAPI_SNIPPET, type ShotSpec } from "@spec/agent"
import { runGitHubGenerate } from "./generate-github"

interface CliArgs {
  command: string | undefined
  file: string | undefined
  debug: boolean
  help: boolean
  dryRun: boolean
  shots: number
  model: string | undefined
  effort: "low" | "medium" | "high" | "xhigh" | "max" | undefined
  maxTurns: number | undefined
  runId: string | undefined
  image: string | undefined
  repository: string | undefined
  targetDir: string | undefined
  concurrency: number
  requiredCheck: string
  resume: boolean
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: undefined,
    file: undefined,
    debug: false,
    help: false,
    dryRun: false,
    shots: 3,
    model: undefined,
    maxTurns: undefined,
    runId: undefined,
    image: undefined,
    repository: undefined,
    targetDir: undefined,
    concurrency: 2,
    effort: undefined,
    requiredCheck: "spec-generation",
    resume: false,
  }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--debug") args.debug = true
    else if (arg === "--help" || arg === "-h") args.help = true
    else if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--model") args.model = argv[++i]
    else if (arg === "--effort") args.effort = argv[++i] as CliArgs["effort"]
    else if (arg === "--shots") args.shots = Number(argv[++i])
    else if (arg === "--max-turns") args.maxTurns = Number(argv[++i])
    else if (arg === "--run-id") args.runId = argv[++i]
    else if (arg === "--image") args.image = argv[++i]
    else if (arg === "--repository") args.repository = argv[++i]
    else if (arg === "--target-dir") args.targetDir = argv[++i]
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i])
    else if (arg === "--check") args.requiredCheck = argv[++i]
    else if (arg === "--resume") args.resume = true
    else positional.push(arg)
  }
  args.command = positional[0]
  args.file = positional[1]
  return args
}

const USAGE = `spec ${COMPILER_VERSION} — specification compiler

Usage:
  spec check <file.spec.ts>       Statically check a specification
  spec build <file.spec.ts>       Compile and write artifacts to <outputDir> (default .spec/)
  spec inspect <file.spec.ts>     Print the specification tree
  spec generate <file.spec.ts>    Compile, then generate the application with a
                                  coding agent executing a generation DAG; every
                                  shot must pass the compiler's conformance suite
                                  on the FIRST attempt and all shots must expose
                                  the same interface (the golden rule)
  spec generate-frontend <file.spec.ts>
                                  Generate independent React shots from the UI
                                  blueprint; Playwright verifies behavior and
                                  pixel-identical layout on the first attempt
Options:
  --dry-run                 Plan only: write blueprint + DAG, no agent
  --shots <n>               Independent generations per spec (default 3)
  --model <id>              Pinned coding-agent model (required to execute)
  --effort <level>          Pinned low|medium|high|xhigh|max (required to execute)
  --max-turns <n>           Pinned agent turn budget (required to execute)
  --run-id <id>             Stable GitHub generation run id (required to execute)
  --image <repo@sha256:...> Digest-pinned generator container (required to execute)
  --target-dir <dir>        Repository-relative generated product directory
  --repository <owner/base> Temporary per-shot repository name prefix
  --concurrency <n>         Maximum parallel generator nodes (default 2)
  --check <name>            Required GitHub check (default spec-generation)
  --resume                  Resume the same immutable run from GitHub refs
  --debug                   Show internal stack traces
  --help                    Show this help

There is deliberately no repair option: a nonconformant shot is a
specification defect. Pin the behavior in the spec/blueprint, then
regenerate all shots.

Headless sessions run in safe mode, authorize only the audited generation
file/Python tools, and require model, effort, and turn budget to be frozen in
the immutable plan.
`

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)
  if (args.help || args.command === "help" || args.command === undefined) {
    process.stdout.write(USAGE)
    return args.command === undefined && !args.help ? 2 : 0
  }
  if (!["check", "build", "inspect", "generate", "generate-frontend"].includes(args.command!)) {
    process.stderr.write(`Unknown command "${args.command}".\n\n${USAGE}`)
    return 2
  }
  if (!args.file) {
    process.stderr.write(`Missing <file> argument for "${args.command}".\n\n${USAGE}`)
    return 2
  }

  const projectRoot = process.cwd()
  try {
    if ((args.command === "generate" || args.command === "generate-frontend") && !args.dryRun) {
      if (!args.runId || !args.image || !args.model || !args.effort || args.maxTurns === undefined) {
        throw new Error("GitHub generation requires --run-id, --image, --model, --effort, and --max-turns; use --dry-run to plan without executing")
      }
      if (!["low", "medium", "high", "xhigh", "max"].includes(args.effort)) throw new Error("--effort must be low, medium, high, xhigh, or max")
      if (!Number.isInteger(args.maxTurns) || args.maxTurns < 1) throw new Error("--max-turns must be a positive integer")
      if (!Number.isInteger(args.shots) || args.shots < 1) throw new Error("--shots must be a positive integer")
      if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error("--concurrency must be a positive integer")
      if (!args.requiredCheck.trim()) throw new Error("--check must be non-empty")
    }
    const result = await compile(args.file, {
      projectRoot,
      logger: createLogger({ level: "error" }),
    })

    if (args.command === "inspect") {
      if (!result.ok) {
        printDiagnostics(result.diagnostics)
        process.stderr.write("✗ Specification invalid\n")
        return 1
      }
      process.stdout.write(renderSpecTree(result.ir, result.loadedPackages))
      return 0
    }

    if (args.command === "check") {
      if (result.ok) {
        const warnings = result.diagnostics.filter((d) => d.level === "warning")
        process.stdout.write("✓ Specification valid\n")
        if (warnings.length > 0) printDiagnostics(warnings)
        return 0
      }
      process.stderr.write("✗ Specification invalid\n\n")
      printDiagnostics(result.diagnostics)
      return 1
    }

    if (args.command === "build") {
      if (!result.ok) {
        process.stderr.write("✗ Specification invalid\n\n")
        printDiagnostics(result.diagnostics)
        return 1
      }
      const artifacts = await writeArtifacts(result, projectRoot)
      process.stdout.write("✓ Specification compiled\n")
      process.stdout.write(`✓ IR written to ${path.relative(projectRoot, artifacts.irPath)}\n`)
      const warnings = result.diagnostics.filter((d) => d.level === "warning")
      if (warnings.length > 0) printDiagnostics(warnings)
      return 0
    }

    // ---------------- generate / generate-frontend ----------------
    if (!result.ok) {
      process.stderr.write("✗ Specification invalid — fix these before generating:\n\n")
      printDiagnostics(result.diagnostics)
      return 1
    }

    if (args.command === "generate-frontend") {
      const plan = planFrontendGeneration(result.ir)
      const specDir = path.resolve(projectRoot, result.outputDir)
      fs.mkdirSync(specDir, { recursive: true })
      fs.writeFileSync(path.join(specDir, "frontend.blueprint.json"), stableStringify(plan.blueprint) + "\n", "utf8")
      fs.writeFileSync(
        path.join(specDir, "frontend.agent.tasks.json"),
        stableStringify({
          dag: {
            tasks: plan.dag.tasks.map((task) => ({
              id: task.id,
              label: task.label,
              dependsOn: task.dependsOn,
              scope: task.scope,
              promptSha256: createHash("sha256").update(task.prompt).digest("hex"),
              specNodeIds: task.specNodeIds,
            })),
            edges: plan.dag.edges,
          },
          verification: plan.verification,
          seedFiles: Object.keys(plan.seedFiles).sort(),
          conformanceFiles: Object.keys(plan.conformance.files).sort(),
        }) + "\n",
        "utf8",
      )
      process.stdout.write(
        `✓ Frontend plan derived: ${plan.blueprint.screens.length} screen(s), ${plan.blueprint.components.length} component kind(s), ${plan.dag.tasks.length} DAG task(s)\n`,
      )
      if (args.dryRun) {
        process.stdout.write(`✓ Frontend dry run complete — artifacts in ${path.relative(projectRoot, specDir)}\n`)
        return 0
      }

      const shotSpec: ShotSpec = {
        tasks: plan.dag.tasks,
        seedFiles: plan.seedFiles,
        conformanceFiles: plan.conformance.files,
        conformanceDirs: ["conformance", "conformance-output"],
        verification: plan.verification,
        generatedBy: "react:dag",
        evidenceFiles: [
          "pnpm-lock.yaml",
          ...plan.blueprint.screens.map((_, index) => `conformance-output/layout-${index}.png`),
          "conformance-output/behavior.png",
          "conformance-output/behavior.json",
        ],
      }
      const ok = await runGitHubGenerate({
        repoRoot: projectRoot, runId: args.runId!, image: args.image!, repository: args.repository,
        targetDirectory: args.targetDir, appName: plan.blueprint.app.name, target: "frontend",
        shots: args.shots, concurrency: args.concurrency, requiredCheck: args.requiredCheck,
        resume: args.resume, model: args.model!, effort: args.effort!, maxTurns: args.maxTurns!, shotSpec, ir: result.ir,
      })
      return ok ? 0 : 1
    }

    const plan = planGeneration(result.ir)
    const specDir = path.resolve(projectRoot, result.outputDir)
    fs.mkdirSync(specDir, { recursive: true })
    fs.writeFileSync(
      path.join(specDir, "blueprint.json"),
      stableStringify(plan.blueprint) + "\n",
      "utf8",
    )
    fs.writeFileSync(
      path.join(specDir, "agent.tasks.json"),
      stableStringify({
        dag: {
          tasks: plan.dag.tasks.map((t) => ({
            id: t.id,
            label: t.label,
            dependsOn: t.dependsOn,
            scope: t.scope,
            promptSha256: createHash("sha256").update(t.prompt).digest("hex"),
            specNodeIds: t.specNodeIds,
          })),
          edges: plan.dag.edges,
        },
        verification: plan.verification,
        conformanceFiles: Object.keys(plan.conformance.files).sort(),
      }) + "\n",
      "utf8",
    )

    process.stdout.write(
      `✓ Plan derived: ${plan.blueprint.routes.length} routes, ` +
        `${plan.blueprint.entities.length} entities` +
        (plan.blueprint.auth ? ", auth" : "") +
        `, ${plan.dag.tasks.length} DAG tasks\n`,
    )

    if (args.dryRun) {
      process.stdout.write(
        `✓ Dry run complete — artifacts in ${path.relative(projectRoot, specDir)} (no agent run)\n`,
      )
      return 0
    }

    const shotSpec: ShotSpec = {
      tasks: plan.dag.tasks,
      conformanceFiles: plan.conformance.files,
      conformanceDirs: ["conformance"],
      verification: plan.verification,
      evidenceFiles: ["conformance-output/openapi.json", "conformance-output/behavior.json"],
      evidenceCommands: [
        {
          name: "openapi-evidence",
          command: `mkdir -p conformance-output && .venv/bin/python -W ignore -c ${shellQuote(OPENAPI_SNIPPET)} > conformance-output/openapi.json`,
          timeoutMs: 120_000,
        },
        {
          name: "behavior-evidence",
          command: ".venv/bin/python -W ignore conformance/behavior_snapshot.py > conformance-output/behavior.json",
          timeoutMs: 120_000,
        },
      ],
    }

    const ok = await runGitHubGenerate({
      repoRoot: projectRoot, runId: args.runId!, image: args.image!, repository: args.repository,
      targetDirectory: args.targetDir, appName: plan.blueprint.app.name, target: "backend",
      shots: args.shots, concurrency: args.concurrency, requiredCheck: args.requiredCheck,
      resume: args.resume, model: args.model!, effort: args.effort!, maxTurns: args.maxTurns!, shotSpec, ir: result.ir,
    })
    return ok ? 0 : 1
  } catch (err) {
    if (err instanceof InternalCompilerError) {
      process.stderr.write(`✗ Internal compiler error: ${err.message}\n`)
      if (args.debug) {
        process.stderr.write((err.stack ?? "") + "\n")
      } else {
        process.stderr.write("Run with --debug for details.\n")
      }
      return 2
    }
    process.stderr.write(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`)
    if (args.debug && err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n")
    }
    return 2
  }
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const d of diagnostics) {
    const location = d.source ? `${d.source.file}:${d.source.line}:${d.source.column}` : undefined
    const lines = [d.code, location, "", d.message]
    process.stderr.write(lines.filter((l) => l !== undefined).join("\n") + "\n\n")
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(
        `✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      process.exit(2)
    })
}
