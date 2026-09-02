import { spawn } from "node:child_process"

export interface ProcessResult {
  command: string
  args: string[]
  exitCode: number | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  ok: boolean
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

class TailBuffer {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false

  constructor(private readonly limit: number) {}

  append(chunk: Buffer | string): void {
    let value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (value.length >= this.limit) {
      this.chunks = [value.subarray(value.length - this.limit)]
      this.size = this.limit
      this.truncated = true
      return
    }
    while (this.size + value.length > this.limit && this.chunks.length > 0) {
      const overflow = this.size + value.length - this.limit
      const first = this.chunks[0]
      if (first.length <= overflow) {
        this.chunks.shift()
        this.size -= first.length
      } else {
        this.chunks[0] = first.subarray(overflow)
        this.size -= overflow
      }
      this.truncated = true
    }
    this.chunks.push(value)
    this.size += value.length
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.size).toString()
  }
}

export function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
      throw new Error("maxOutputBytes must be a positive integer")
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = new TailBuffer(maxOutputBytes)
    const stderr = new TailBuffer(maxOutputBytes)
    let settled = false
    const finish = (exitCode: number | null, extra = "") => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (extra) stderr.append(extra)
      resolve({
        command,
        args,
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        ok: exitCode === 0,
      })
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(null, `\nTimed out after ${options.timeoutMs ?? 45 * 60_000}ms.`)
    }, options.timeoutMs ?? 45 * 60_000)
    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk))
    child.on("error", (error) => finish(null, `\n${error.message}`))
    child.on("close", (code) => finish(code))
    if (options.input !== undefined) child.stdin.write(options.input)
    child.stdin.end()
  })
}

export function commandFailure(result: ProcessResult): Error {
  return new Error(
    `${result.command} ${result.args.join(" ")} failed (${String(result.exitCode)}): ${(result.stderr || result.stdout).slice(-4000)}`,
  )
}
