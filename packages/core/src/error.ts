/**
 * Raised on compiler bugs — as opposed to user errors, which are always
 * reported as structured Diagnostics. The CLI hides stack traces for
 * InternalCompilerError unless `--debug` is passed.
 */
export class InternalCompilerError extends Error {
  readonly details: Record<string, unknown>

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = "InternalCompilerError"
    this.details = details
  }
}
