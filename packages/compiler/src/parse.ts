/**
 * TypeScript frontend (validation layer 1: TS syntax, layer 2: spec syntax
 * restrictions).
 *
 * The specification is read through the TypeScript Compiler API. It is
 * NEVER executed as a JavaScript program. This module parses the source
 * and enforces the allowed TypeScript subset.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import ts from "typescript"
import type { Diagnostic } from "@spec/core"
import { diagnostic } from "./diagnostics"

export interface ParsedImport {
  moduleSpecifier: string
  /** local name -> imported export name */
  named: Array<{ imported: string; local: string }>
}

export interface ParsedSpec {
  /** Path used in diagnostics / IR source locations (project-relative). */
  file: string
  sourceFile: ts.SourceFile
  imports: ParsedImport[]
  diagnostics: Diagnostic[]
}

/** Path displayed in diagnostics/IR: stable across machines. */
export function displayPath(absoluteFile: string, projectRoot: string): string {
  const rel = path.relative(projectRoot, absoluteFile).replace(/\\/g, "/")
  return rel.startsWith("..") ? absoluteFile.replace(/\\/g, "/") : rel
}

const FORBIDDEN_MODULE_PATTERN =
  /^(node:)?(fs|fs\/promises|path|os|http|https|http2|net|tls|dns|child_process|worker_threads|v8|repl|vm|cluster|dgram)(\/.*)?$/

interface RestrictionContext {
  sourceFile: ts.SourceFile
  displayFile: string
  diagnostics: Diagnostic[]
}

function location(ctx: RestrictionContext, node: ts.Node) {
  const { line, character } = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart(ctx.sourceFile))
  return { file: ctx.displayFile, line: line + 1, column: character + 1 }
}

function restricted(ctx: RestrictionContext, node: ts.Node, message: string, code = "SPEC_UNSUPPORTED_SYNTAX") {
  ctx.diagnostics.push(diagnostic(code, "error", message, { source: location(ctx, node) }))
}

/** Parse a .spec.ts file and enforce the allowed TypeScript subset. */
export function parseSpecFile(file: string, displayFile: string = file): ParsedSpec {
  const content = fs.readFileSync(file, "utf8")
  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const diagnostics: Diagnostic[] = []
  const ctx: RestrictionContext = { sourceFile, displayFile, diagnostics }

  // Layer 1: syntax errors
  const parseDiagList = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics ?? []
  for (const parseDiag of parseDiagList) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(parseDiag.start ?? 0)
    diagnostics.push(
      diagnostic(
        "SPEC_SYNTAX_ERROR",
        "error",
        ts.flattenDiagnosticMessageText(parseDiag.messageText, "\n"),
        { source: { file: displayFile, line: line + 1, column: character + 1 } },
      ),
    )
  }

  // Layer 2: spec syntax restrictions
  scanRestrictions(ctx)

  // Collect imports
  const imports: ParsedImport[] = []
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
      const named: ParsedImport["named"] = []
      if (statement.importClause) {
        const clause = statement.importClause
        if (clause.name) {
          restricted(
            ctx,
            statement,
            "Default imports are not allowed in specifications (use named imports).",
          )
        }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          restricted(
            ctx,
            statement,
            "Namespace imports (`import * as ns`) are not allowed in specifications.",
          )
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            named.push({
              imported: element.propertyName
                ? element.propertyName.text
                : element.name.text,
              local: element.name.text,
            })
          }
        }
      }
      imports.push({ moduleSpecifier: specifier, named })
    }
  }

  return { file: displayFile, sourceFile, imports, diagnostics }
}

function scanRestrictions(ctx: RestrictionContext) {
  const { sourceFile } = ctx
  const visit = (node: ts.Node): void => {
    // Forbidden constructs (spec §32)
    if (
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node)
    ) {
      restricted(ctx, node, "Loops are not allowed in specifications.")
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      restricted(ctx, node, "Dynamic import() is not allowed in specifications.")
    } else if (ts.isAwaitExpression(node)) {
      restricted(ctx, node, "Await expressions are not allowed in specifications.")
    } else if (ts.isFunctionDeclaration(node)) {
      restricted(ctx, node, "Function declarations are not allowed in specifications.")
    } else if (ts.isClassDeclaration(node)) {
      restricted(ctx, node, "Class declarations are not allowed in specifications.")
    } else if (ts.isEnumDeclaration(node)) {
      restricted(ctx, node, "Enums are not allowed in specifications.")
    } else if (ts.isVariableStatement(node)) {
      const hasNonConst = node.declarationList.declarations.some(
        (d) => !!(d.flags & (ts.NodeFlags.Let | ts.NodeFlags.Using)),
      )
      if (hasNonConst) {
        restricted(ctx, node, "Only `const` declarations are allowed in specifications.")
      }
    } else if (ts.isImportDeclaration(node)) {
      const specifier = (node.moduleSpecifier as ts.StringLiteral).text
      if (FORBIDDEN_MODULE_PATTERN.test(specifier)) {
        ctx.diagnostics.push(
          diagnostic(
            "SPEC_FORBIDDEN_IMPORT",
            "error",
            `Importing "${specifier}" is forbidden: specifications cannot access the filesystem or network.`,
            { source: location(ctx, node) },
          ),
        )
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text
      if (callee === "eval" || callee === "Function") {
        ctx.diagnostics.push(
          diagnostic(
            "SPEC_FORBIDDEN_CALL",
            "error",
            `Calling ${callee}() is forbidden in specifications.`,
            { source: location(ctx, node) },
          ),
        )
      }
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const root = node.expression.text
      const member = node.name.text
      const forbidden: Record<string, Set<string>> = {
        process: new Set(["env", "exit", "kill", "binding"]),
        Date: new Set(["now"]),
        Math: new Set(["random"]),
        globalThis: new Set(["fetch", "require", "process"]),
      }
      if (forbidden[root]?.has(member)) {
        ctx.diagnostics.push(
          diagnostic(
            "SPEC_FORBIDDEN_ACCESS",
            "error",
            `Accessing ${root}.${member} is forbidden in specifications (nondeterministic or side-effecting).`,
            { source: location(ctx, node) },
          ),
        )
      }
    }

    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
}
