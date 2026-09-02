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
import { compareFrontendShots, planFrontendGeneration } from "@spec/react"
import { runRepeatability, runShot, type ShotSpec } from "@spec/agent"

interface CliArgs {
  command: string | undefined
  file: string | undefined
  debug: boolean
  help: boolean
  dryRun: boolean
  out: string | undefined
  shots: number
  model: string | undefined
  maxTurns: number | undefined
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: undefined,
    file: undefined,
    debug: false,
    help: false,
    dryRun: false,
    out: undefined,
    shots: 3,
    model: undefined,
    maxTurns: undefined,
  }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--debug") args.debug = true
    else if (arg === "--help" || arg === "-h") args.help = true
    else if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--out") args.out = argv[++i]
    else if (arg === "--model") args.model = argv[++i]
    else if (arg === "--shots") args.shots = Number(argv[++i])
    else if (arg === "--max-turns") args.maxTurns = Number(argv[++i])
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
  --out <dir>               Generation output root (default "out/")
  --shots <n>               Independent generations per spec (default 3)
  --model <id>              Override Claude Code's configured/default model
  --max-turns <n>           Override Claude Code's configured/default turn budget
  --debug                   Show internal stack traces
  --help                    Show this help

There is deliberately no repair option: a nonconformant shot is a
specification defect. Pin the behavior in the spec/blueprint, then
regenerate all shots.

Headless sessions authorize only the audited generation file/Python tools;
model selection and turn budget remain Claude Code defaults unless overridden.
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

      const outRoot = args.out ? path.resolve(projectRoot, args.out) : path.join(projectRoot, "out")
      const workspaces = Array.from({ length: args.shots }, (_, index) => ({
        shot: `shot-${index + 1}`,
        workspace: path.join(outRoot, `${plan.blueprint.app.name.toLowerCase()}-frontend-${index + 1}`),
      }))
      const shotSpec: ShotSpec = {
        tasks: plan.dag.tasks,
        seedFiles: plan.seedFiles,
        conformanceFiles: plan.conformance.files,
        conformanceDirs: ["conformance", "conformance-output"],
        verification: plan.verification,
        generatedBy: "react:dag",
      }
      process.stdout.write(`⟳ Generating ${args.shots} independent frontend shot(s) in parallel; each receives the same immutable runtime and oracle…\n`)
      const shots = await Promise.all(workspaces.map(({ shot, workspace }) => runShot(shot, workspace, shotSpec, {
        model: args.model,
        maxTurns: args.maxTurns,
      })))
      const equality = compareFrontendShots(workspaces)
      const ok = shots.every((shot) => shot.ok) && equality.ok
      for (const shot of shots) {
        process.stdout.write(`${shot.ok ? "✓" : "✗"} ${shot.shot}: ${shot.ok ? "Playwright conformance passed (first attempt, no repair)" : "FAILED"} → ${path.relative(projectRoot, shot.workspace)}\n`)
      }
      process.stdout.write(equality.layoutEqual ? "✓ Initial layout screenshots are pixel-identical\n" : "✗ Initial layout screenshots differ\n")
      process.stdout.write(equality.behaviorImageEqual ? "✓ Post-interaction screenshots are pixel-identical\n" : "✗ Post-interaction screenshots differ\n")
      process.stdout.write(equality.behaviorEqual ? "✓ Browser behavior snapshots are identical\n" : "✗ Browser behavior snapshots differ\n")
      fs.writeFileSync(
        path.join(specDir, "frontend.result.json"),
        stableStringify({
          ok,
          equality,
          shots: shots.map((shot) => ({
            shot: shot.shot,
            workspace: shot.workspace,
            ok: shot.ok,
            tasks: shot.tasks,
            verification: shot.verification,
            diagnostics: shot.diagnostics,
            artifacts: shot.artifacts,
            totalCostUsd: shot.totalCostUsd,
          })),
        }) + "\n",
        "utf8",
      )
      process.stdout.write(ok
        ? `✓ Frontend generation satisfies the golden rule across ${shots.length} shots\n`
        : `✗ Frontend generation violated the golden rule; redesign the spec/runtime and regenerate every shot\n`)
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

    const outRoot = args.out ? path.resolve(projectRoot, args.out) : path.join(projectRoot, "out")
    const appName = plan.blueprint.app.name
    const workspaces = Array.from({ length: args.shots }, (_, i) => ({
      shot: `shot-${i + 1}`,
      workspace: path.join(outRoot, `${appName.toLowerCase()}-${i + 1}`),
    }))

    const shotSpec: ShotSpec = {
      tasks: plan.dag.tasks,
      conformanceFiles: plan.conformance.files,
      conformanceDirs: ["conformance"],
      verification: plan.verification,
    }

    process.stdout.write(
      `⟳ Generating ${args.shots} independent shot(s) in parallel, ${plan.dag.tasks.length} DAG tasks each (this takes a while)…\n`,
    )
    const report = await runRepeatability(shotSpec, workspaces, {
      model: args.model,
      maxTurns: args.maxTurns,
    })

    for (const shot of report.shots) {
      const mark = shot.ok ? "✓" : "✗"
      const cost = shot.totalCostUsd !== undefined ? ` · $${shot.totalCostUsd.toFixed(2)}` : ""
      const violations = shot.tasks
        .filter((t) => t.scopeViolations.length > 0)
        .map((t) => `${t.id}→${t.scopeViolations.length} out-of-scope file(s)`)
        .join(", ")
      process.stdout.write(
        `${mark} ${shot.shot}: ${shot.ok ? "conformance passed (first attempt, no repair)" : "FAILED"}${cost} → ${path.relative(projectRoot, shot.workspace)}\n` +
          (violations ? `    scope violations: ${violations}\n` : ""),
      )
    }

    if (workspaces.length > 1) {
      process.stdout.write(
        report.interfaceEqual
          ? "✓ All shots expose an identical OpenAPI interface\n"
          : "✗ Shots expose DIFFERENT interfaces (golden rule violated)\n",
      )
      process.stdout.write(
        report.behaviorEqual
          ? "✓ All shots produce an identical compiler-owned behavior snapshot\n"
          : "✗ Shots behave DIFFERENTLY (golden rule violated)\n",
      )
    }

    fs.writeFileSync(
      path.join(specDir, "agent.result.json"),
      stableStringify({
        ok: report.ok,
        interfaceEqual: report.interfaceEqual,
        behaviorEqual: report.behaviorEqual,
        behaviors: report.behaviors,
        totalCostUsd: report.totalCostUsd,
        shots: report.shots.map((s) => ({
          shot: s.shot,
          workspace: s.workspace,
          ok: s.ok,
          tasks: s.tasks.map((t) => ({
            id: t.id,
            ok: t.ok,
            run: { sessionId: t.run.sessionId, turns: t.run.turns, costUsd: t.run.costUsd },
            produced: t.produced,
            scopeViolations: t.scopeViolations,
            durationMs: t.durationMs,
          })),
          verification: s.verification,
          artifactCount: s.artifacts.length,
          artifacts: s.artifacts,
          diagnostics: s.diagnostics,
        })),
        diagnostics: report.diagnostics,
      }) + "\n",
      "utf8",
    )

    const errors = report.diagnostics.filter((d) => d.level === "error")
    if (errors.length > 0) printDiagnostics(errors)
    process.stdout.write(
      report.ok
        ? `✓ Generation repeatable across ${workspaces.length} shot(s), zero repairs — results in ${path.relative(projectRoot, specDir)}/agent.result.json\n`
        : `✗ Generation did not satisfy the golden rule — fix the spec/blueprint and regenerate; see ${path.relative(projectRoot, specDir)}/agent.result.json\n`,
    )
    return report.ok ? 0 : 1
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
