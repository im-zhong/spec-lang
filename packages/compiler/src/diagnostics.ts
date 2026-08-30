/**
 * Compiler-level diagnostic codes and helpers.
 *
 * Domain-specific codes (AUTH_*, FIELD_*, ...) are owned by their
 * packages; the compiler core only emits structural codes.
 */
import type { Diagnostic, DiagnosticLevel, SourceLocation } from "@spec/core"

export function diagnostic(
  code: string,
  level: DiagnosticLevel,
  message: string,
  extra: {
    source?: SourceLocation
    nodeId?: string
    details?: Record<string, unknown>
  } = {},
): Diagnostic {
  return { code, level, message, ...extra }
}

export function errorOf(d: Diagnostic): boolean {
  return d.level === "error"
}

/** Deterministic diagnostic ordering. */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const aFile = a.source?.file ?? ""
    const bFile = b.source?.file ?? ""
    if (aFile !== bFile) return aFile < bFile ? -1 : 1
    const aLine = a.source?.line ?? 0
    const bLine = b.source?.line ?? 0
    if (aLine !== bLine) return aLine - bLine
    const aCol = a.source?.column ?? 0
    const bCol = b.source?.column ?? 0
    if (aCol !== bCol) return aCol - bCol
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0
  })
}
