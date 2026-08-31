import type { Diagnostic } from "@spec/core"

/** Diagnostic factory shared by the agent orchestration layer. */
export function diagnostic(
  code: string,
  level: Diagnostic["level"],
  message: string,
  extra: Omit<Diagnostic, "code" | "level" | "message"> = {},
): Diagnostic {
  return { code, level, message, ...extra }
}
