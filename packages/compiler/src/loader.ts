/**
 * Trusted package loader.
 *
 * Resolution uses ordinary Node.js / pnpm package resolution from the
 * spec file's location. Loading executes TRUSTED package code only
 * (published spec packages); user specification code is never executed —
 * that boundary is a core security property of this compiler.
 */
import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as path from "node:path"
import type { SpecPackage } from "@spec/core"
import { diagnostic } from "./diagnostics"

export interface LoadedSpecPackage {
  name: string
  version: string
  /** Package definition from its `spec.entry` module (default export). */
  definition: SpecPackage
  /** Trusted DSL exports used by the static evaluator. */
  exports: Record<string, unknown>
}

export class PackageLoader {
  private cache = new Map<string, LoadedSpecPackage | Error>()
  private readonly require: NodeRequire

  constructor(fromDir: string) {
    this.require = createRequire(path.resolve(fromDir, "spec-loader.js"))
  }

  load(moduleSpecifier: string): LoadedSpecPackage | Error {
    if (this.cache.has(moduleSpecifier)) {
      return this.cache.get(moduleSpecifier)!
    }
    const result = this.loadUncached(moduleSpecifier)
    this.cache.set(moduleSpecifier, result)
    return result
  }

  private loadUncached(moduleSpecifier: string): LoadedSpecPackage | Error {
    try {
      const nodeRequire = this.require
      const pkgJsonPath = nodeRequire.resolve(`${moduleSpecifier}/package.json`)
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
        name?: string
        version?: string
        main?: string
        spec?: { package?: boolean; entry?: string }
      }
      if (!pkgJson.spec?.package) {
        return new Error(
          `"${moduleSpecifier}" is not a specification package (missing "spec.package" metadata)`,
        )
      }

      const pkgRoot = path.dirname(pkgJsonPath)
      const name = pkgJson.name ?? moduleSpecifier
      const version = pkgJson.version ?? "0.0.0"

      let definition: SpecPackage = { name, version }
      if (pkgJson.spec.entry) {
        const entryPath = path.resolve(pkgRoot, pkgJson.spec.entry)
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const entry = require(entryPath) as { default?: SpecPackage }
        if (entry?.default) {
          definition = entry.default
        } else {
          return new Error(
            `"${name}" spec entry has no default SpecPackage export (${pkgJson.spec.entry})`,
          )
        }
      }

      const exports = nodeRequire(moduleSpecifier) as Record<string, unknown>
      return { name, version, definition, exports: exports ?? {} }
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err))
    }
  }
}

export function loadFailureDiagnostic(
  moduleSpecifier: string,
  error: Error,
): ReturnType<typeof diagnostic> {
  return diagnostic(
    "SPEC_PACKAGE_LOAD_FAILED",
    "error",
    `Failed to load specification package "${moduleSpecifier}": ${error.message}`,
    { details: { moduleSpecifier } },
  )
}
