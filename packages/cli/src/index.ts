#!/usr/bin/env node
/**
 * spec — the specification compiler CLI.
 *
 * Commands:
 *   spec check <file>     parse + resolve + validate + link (no artifacts)
 *   spec build <file>     full compile, writes .spec/ artifacts
 *   spec inspect <file>   render a human-readable specification tree
 *
 * Exit codes:
 *   0  success
 *   1  specification error (structured diagnostics)
 *   2  compiler / internal error (stack traces only with --debug)
 */
import * as path from "node:path"
import { compile, renderSpecTree, writeArtifacts, COMPILER_VERSION } from "@spec/compiler"
import { InternalCompilerError, createLogger, type Diagnostic } from "@spec/core"

interface CliArgs {
  command: string | undefined
  file: string | undefined
  debug: boolean
  help: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: undefined, file: undefined, debug: false, help: false }
  const positional: string[] = []
  for (const arg of argv) {
    if (arg === "--debug") args.debug = true
    else if (arg === "--help" || arg === "-h") args.help = true
    else positional.push(arg)
  }
  args.command = positional[0]
  args.file = positional[1]
  return args
}

const USAGE = `spec ${COMPILER_VERSION} — specification compiler

Usage:
  spec check <file.spec.ts>     Statically check a specification
  spec build <file.spec.ts>     Compile and write artifacts to <outputDir> (default .spec/)
  spec inspect <file.spec.ts>   Print the specification tree

Options:
  --debug    Show internal stack traces
  --help     Show this help
`

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)
  if (args.help || args.command === "help" || args.command === undefined) {
    process.stdout.write(USAGE)
    return args.command === undefined && !args.help ? 2 : 0
  }
  if (!["check", "build", "inspect"].includes(args.command)) {
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

    // build
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
