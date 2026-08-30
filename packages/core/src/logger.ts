/** Minimal structured logger used across the toolchain. */
export interface Logger {
  debug(message: string, details?: Record<string, unknown>): void
  info(message: string, details?: Record<string, unknown>): void
  warn(message: string, details?: Record<string, unknown>): void
  error(message: string, details?: Record<string, unknown>): void
}

export interface LoggerOptions {
  level?: "debug" | "info" | "warn" | "error" | "silent"
  sink?: (line: string) => void
}

const LEVEL_ORDER: Record<NonNullable<LoggerOptions["level"]>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? "info"]
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + "\n"))
  const emit = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    details?: Record<string, unknown>,
  ) => {
    if (LEVEL_ORDER[level] < threshold) return
    const suffix = details && Object.keys(details).length > 0 ? " " + JSON.stringify(details) : ""
    sink(`[${level}] ${message}${suffix}`)
  }
  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
  }
}

export const silentLogger: Logger = createLogger({ level: "silent" })
