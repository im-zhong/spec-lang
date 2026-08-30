/**
 * spec.config.ts support (MVP: outputDir only).
 *
 * The config is read statically (TypeScript AST), consistent with the
 * "never execute user code" rule.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import ts from "typescript"

export interface SpecConfig {
  outputDir: string
}

export const DEFAULT_CONFIG: SpecConfig = { outputDir: ".spec" }

export function loadSpecConfig(projectRoot: string): SpecConfig {
  const file = path.join(projectRoot, "spec.config.ts")
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG }
  try {
    const sourceFile = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    )
    for (const statement of sourceFile.statements) {
      if (!ts.isExportAssignment(statement)) continue
      if (!ts.isObjectLiteralExpression(statement.expression)) break
      for (const property of statement.expression.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "outputDir" &&
          ts.isStringLiteral(property.initializer)
        ) {
          return { outputDir: property.initializer.text }
        }
      }
    }
  } catch {
    // Malformed config falls back to defaults; keep the compiler resilient.
  }
  return { ...DEFAULT_CONFIG }
}
