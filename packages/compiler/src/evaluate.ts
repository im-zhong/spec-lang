/**
 * Static evaluator (part of validation layer 2/3).
 *
 * Evaluates the allowed expression subset of a specification WITHOUT
 * executing user code:
 *
 *   - literals, identifiers bound to consts, property access, calls,
 *     array literals, object literals
 *   - calls are dispatched ONLY to functions imported from trusted
 *     specification packages (or methods on their results)
 *
 * Anything else produces a structured diagnostic.
 */
import ts from "typescript"
import { isNodeBuilder, type SpecNodeBuilder } from "@spec/core"
import type { Diagnostic } from "@spec/core"
import { diagnostic } from "./diagnostics"
import type { ParsedSpec } from "./parse"

export interface ImportedBinding {
  packageName: string
  imported: string
  value: unknown
}

export interface EvaluationResult {
  /** const name -> evaluated value, in source declaration order. */
  bindings: Map<string, unknown>
  /** Node builders bound to a top-level const, in source declaration order. */
  nodes: SpecNodeBuilder[]
  /** Result of `export default ...` if it is a node builder. */
  appNode: SpecNodeBuilder | undefined
  /** Diagnostics produced during static evaluation. */
  diagnostics: Diagnostic[]
}

interface Env {
  sourceFile: ts.SourceFile
  /** Display path used in diagnostics (project-relative). */
  filePath: string
  consts: Map<string, unknown>
  imports: Map<string, ImportedBinding>
  diagnostics: Diagnostic[]
}

function loc(env: Env, node: ts.Node) {
  const pos = node.getStart(env.sourceFile)
  const { line, character } = env.sourceFile.getLineAndCharacterOfPosition(pos)
  return { file: env.filePath, line: line + 1, column: character + 1 }
}

function fail(env: Env, node: ts.Node, code: string, message: string, details?: Record<string, unknown>) {
  env.diagnostics.push(diagnostic(code, "error", message, { source: loc(env, node), details }))
}

export function evaluateSpec(
  parsed: ParsedSpec,
  imports: Map<string, ImportedBinding>,
): EvaluationResult {
  const env: Env = {
    sourceFile: parsed.sourceFile,
    filePath: parsed.file,
    consts: new Map(),
    imports,
    diagnostics: [],
  }

  const nodes: SpecNodeBuilder[] = []
  let appNode: SpecNodeBuilder | undefined

  for (const statement of parsed.sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      continue // handled by the resolver
    }
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) {
          fail(env, decl, "SPEC_UNSUPPORTED_SYNTAX", "Destructuring declarations are not allowed.")
          continue
        }
        if (decl.initializer === undefined) {
          fail(env, decl, "SPEC_UNSUPPORTED_SYNTAX", "Const declarations must have an initializer.")
          continue
        }
        const value = evaluateExpression(decl.initializer, env)
        env.consts.set(decl.name.text, value)
        if (isNodeBuilder(value)) {
          // Anonymous nodes adopt their const name — deterministic and
          // traceable back to the source.
          if (!value.name) value.name = decl.name.text
          nodes.push(value)
        }
      }
      continue
    }
    if (ts.isExportAssignment(statement)) {
      const value = evaluateExpression(statement.expression, env)
      if (isNodeBuilder(value)) {
        appNode = value
      } else {
        fail(
          env,
          statement,
          "SPEC_NO_APP",
          "`export default` must be a spec node produced by e.g. defineApp({...}).",
        )
      }
      continue
    }
    if (
      // These statements are already reported by the restriction scan in
      // parse.ts — skip them here to avoid duplicate diagnostics.
      ts.isWhileStatement(statement) ||
      ts.isDoStatement(statement) ||
      ts.isForStatement(statement) ||
      ts.isForOfStatement(statement) ||
      ts.isForInStatement(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      continue
    }
    if (statement.kind === ts.SyntaxKind.EndOfFileToken) continue
    fail(
      env,
      statement,
      "SPEC_UNSUPPORTED_SYNTAX",
      `Statement "${ts.SyntaxKind[statement.kind]}" is not allowed in specifications (allowed: import, const, export default).`,
    )
  }

  if (appNode === undefined && !hasCode(env.diagnostics, "SPEC_NO_APP")) {
    env.diagnostics.push(
      diagnostic(
        "SPEC_NO_APP",
        "error",
        "Specification must have `export default defineApp({...})`.",
        { source: { file: parsed.file, line: 1, column: 1 } },
      ),
    )
  }

  return { bindings: env.consts, nodes, appNode, diagnostics: env.diagnostics }
}

function hasCode(diagnostics: Diagnostic[], code: string): boolean {
  return diagnostics.some((d) => d.code === code)
}

function evaluateExpression(expr: ts.Expression, env: Env): unknown {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  if (ts.isNumericLiteral(expr)) return Number(expr.text)
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null

  if (ts.isIdentifier(expr)) {
    const name = expr.text
    if (env.consts.has(name)) return env.consts.get(name)
    const imported = env.imports.get(name)
    if (imported) return imported.value
    fail(
      env,
      expr,
      "SPEC_UNKNOWN_IDENTIFIER",
      `Unknown identifier "${name}". Only local consts and imports from spec packages can be used.`,
      { details: { identifier: name } },
    )
    return undefined
  }

  if (ts.isPropertyAccessExpression(expr) && !ts.isPrivateIdentifier(expr.name)) {
    const receiver = evaluateExpression(expr.expression, env)
    if (receiver === undefined && hasFailureAt(env, expr.expression)) return undefined
    const member = expr.name.text
    if (
      typeof receiver === "object" &&
      receiver !== null &&
      Object.prototype.hasOwnProperty.call(receiver, member)
    ) {
      return (receiver as Record<string, unknown>)[member]
    }
    fail(
      env,
      expr,
      "SPEC_UNKNOWN_PROPERTY",
      `Cannot read property "${member}"${
        receiver === null || receiver === undefined
          ? ` of ${String(receiver)}`
          : ` from a ${describeValue(receiver)}`
      }.`,
    )
    return undefined
  }

  if (ts.isObjectLiteralExpression(expr)) {
    const out: Record<string, unknown> = {}
    for (const property of expr.properties) {
      if (property.name === undefined || ts.isComputedPropertyName(property.name)) {
        fail(env, property, "SPEC_UNSUPPORTED_SYNTAX", "Computed property names are not allowed.")
        continue
      }
      const key = ts.isIdentifier(property.name)
        ? property.name.text
        : ts.isStringLiteral(property.name)
          ? property.name.text
          : ts.isNumericLiteral(property.name)
            ? property.name.text
            : undefined
      if (key === undefined) {
        fail(env, property, "SPEC_UNSUPPORTED_SYNTAX", "Unsupported object property name.")
        continue
      }
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        fail(
          env,
          property,
          "SPEC_DUPLICATE_KEY",
          `Duplicate key "${key}" in object literal.`,
          { details: { key } },
        )
        continue
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        out[key] = evaluateExpression(property.name, env)
        continue
      }
      if (ts.isPropertyAssignment(property)) {
        out[key] = evaluateExpression(property.initializer, env)
        continue
      }
      fail(
        env,
        property,
        "SPEC_UNSUPPORTED_SYNTAX",
        `Object property kind "${ts.SyntaxKind[property.kind]}" is not allowed (getters, setters, spread and methods are unsupported).`,
      )
    }
    return out
  }

  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.map((element) => {
      if (ts.isSpreadElement(element)) {
        fail(env, element, "SPEC_UNSUPPORTED_SYNTAX", "Spread is not allowed in specifications.")
        return undefined
      }
      return evaluateExpression(element, env)
    })
  }

  if (ts.isCallExpression(expr)) {
    return evaluateCall(expr, env)
  }

  // Unary minus over a numeric literal is pure data (e.g. delta: -1),
  // deterministic and side-effect free — the only unary form admitted.
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return -Number(expr.operand.text)
  }

  fail(
    env,
    expr,
    "SPEC_UNSUPPORTED_SYNTAX",
    `Expression "${ts.SyntaxKind[expr.kind]}" is not allowed in specifications.`,
  )
  return undefined
}

function evaluateCall(expr: ts.CallExpression, env: Env): unknown {
  let receiver: unknown = undefined
  let fn: unknown
  let label: string

  if (ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text
    const imported = env.imports.get(name)
    if (imported) {
      fn = imported.value
      label = `${imported.packageName}::${imported.imported}`
    } else if (env.consts.has(name)) {
      fn = env.consts.get(name)
      label = name
    } else {
      fail(
        env,
        expr,
        "SPEC_UNKNOWN_IDENTIFIER",
        `Call to unknown identifier "${name}". Only functions imported from spec packages can be called.`,
        { details: { identifier: name } },
      )
      return undefined
    }
  } else if (ts.isPropertyAccessExpression(expr.expression) && !ts.isPrivateIdentifier(expr.expression.name)) {
    receiver = evaluateExpression(expr.expression.expression, env)
    const member = expr.expression.name.text
    if (
      typeof receiver === "object" &&
      receiver !== null &&
      Object.prototype.hasOwnProperty.call(receiver, member)
    ) {
      fn = (receiver as Record<string, unknown>)[member]
      label = `${describeValue(receiver)}.${member}`
    } else {
      fail(
        env,
        expr,
        "SPEC_UNKNOWN_PROPERTY",
        `Cannot call "${member}"${
          receiver === null || receiver === undefined
            ? ` of ${String(receiver)}`
            : ` from a ${describeValue(receiver)}`
        }.`,
      )
      return undefined
    }
  } else {
    fail(
      env,
      expr,
      "SPEC_UNSUPPORTED_SYNTAX",
      `Unsupported call target "${ts.SyntaxKind[expr.expression.kind]}".`,
    )
    return undefined
  }

  if (typeof fn !== "function") {
    fail(env, expr, "SPEC_NOT_CALLABLE", `"${label}" is not callable.`)
    return undefined
  }

  const args = expr.arguments.map((arg) => {
    if (ts.isSpreadElement(arg)) {
      fail(env, arg, "SPEC_UNSUPPORTED_SYNTAX", "Spread arguments are not allowed.")
      return undefined
    }
    return evaluateExpression(arg, env)
  })

  try {
    const bound = receiver === undefined ? fn : (fn as (...a: unknown[]) => unknown).bind(receiver)
    const result = (bound as (...a: unknown[]) => unknown)(...args)
    if (isNodeBuilder(result) && result.source === undefined) {
      result.source = loc(env, expr)
    }
    return result
  } catch (err) {
    fail(
      env,
      expr,
      "SPEC_BUILDER_FAILED",
      `Calling "${label}" failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return undefined
  }
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "array"
  if (typeof value === "object" && value !== null) {
    const kind = (value as Record<string, unknown>).kind
    return typeof kind === "string" ? `"${kind}" spec node` : "object"
  }
  return typeof value
}

/** Whether a diagnostic was already emitted for the exact source position. */
function hasFailureAt(env: Env, node: ts.Node): boolean {
  const pos = node.getStart(env.sourceFile)
  return env.diagnostics.some(
    (d) => d.source?.file === env.filePath && lineOf(env, pos, d.source),
  )
}

function lineOf(env: Env, pos: number, source: { line: number }): boolean {
  const { line } = env.sourceFile.getLineAndCharacterOfPosition(pos)
  return line + 1 === source.line
}
