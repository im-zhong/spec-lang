/**
 * Repeatability harness — the golden rule, machine-checked.
 *
 *   same specification  →  N independent generations (shots)
 *                       →  every shot passes the SAME conformance suite
 *                       →  every shot exposes the SAME normalized OpenAPI
 *                          interface
 *
 * If any shot fails conformance, or any two shots diverge on their
 * observable interface, generation is NOT repeatable and the report says
 * so. The fix then belongs in the spec vocabulary or the compiler (pin
 * more of the contract), not in hoping the agent behaves next time.
 */
import type { Diagnostic } from "@spec/core"
import { diagnostic } from "./diagnostics"
import { runCommand, runShot, type ShotOptions, type ShotReport, type ShotSpec } from "./orchestrate"

/**
 * Deterministic OpenAPI snapshot: run inside a workspace, prints a
 * canonical JSON of paths/methods/statuses/params/body-required. The
 * agent's naming choices (operationId, tags, descriptions) are ignored by
 * construction — only client-observable interface facts are kept.
 */
export const OPENAPI_SNIPPET = `import json
from app.main import app
spec = app.openapi()
norm = {}
for path, ops in spec.get("paths", {}).items():
    for method, op in ops.items():
        if method not in ("get", "post", "put", "patch", "delete"):
            continue
        norm[f"{method.upper()} {path}"] = {
            "statuses": sorted(op.get("responses", {}).keys()),
            "pathParams": sorted(p["name"] for p in op.get("parameters", []) if p.get("in") == "path"),
            "requestBody": bool(op.get("requestBody", {}).get("required", False)),
        }
print(json.dumps(norm, sort_keys=True, indent=2))
`

export interface RepeatabilityReport {
  ok: boolean
  shots: ShotReport[]
  /** Canonical OpenAPI interface per shot (null when capture failed). */
  interfaces: Array<{ shot: string; snapshot: string | null }>
  interfaceEqual: boolean
  diagnostics: Diagnostic[]
  totalCostUsd: number
}

export interface RepeatabilityOptions extends ShotOptions {
  /** Python used for OpenAPI snapshots; default "<workspace>/.venv/bin/python". */
  pythonCommand?: (workspace: string) => string
}

export async function runRepeatability(
  spec: ShotSpec,
  shotWorkspaces: Array<{ shot: string; workspace: string }>,
  options: RepeatabilityOptions = {},
): Promise<RepeatabilityReport> {
  const shots: ShotReport[] = []
  const diagnostics: Diagnostic[] = []
  let totalCostUsd = 0

  for (const { shot, workspace } of shotWorkspaces) {
    const report = await runShot(shot, workspace, spec, options)
    shots.push(report)
    diagnostics.push(...report.diagnostics)
    totalCostUsd += report.totalCostUsd
  }

  const allConformant = shots.every((s) => s.ok)
  if (allConformant && shots.length > 1) {
    diagnostics.push(
      diagnostic(
        "REPEATABLE",
        "info",
        `All ${shots.length} independent generations passed the same conformance suite.`,
        { details: { shots: shots.map((s) => s.shot) } },
      ),
    )
  }

  /* Cross-shot interface equality (only meaningful for conformant shots). */
  const interfaces: RepeatabilityReport["interfaces"] = []
  for (const { shot, workspace } of shotWorkspaces) {
    const python = options.pythonCommand
      ? options.pythonCommand(workspace)
      : `${workspace}/.venv/bin/python`
    const result = await runCommand(
      `${python} -c ${shellQuote(OPENAPI_SNIPPET)}`,
      workspace,
      "openapi-snapshot",
      120_000,
    )
    interfaces.push({
      shot,
      snapshot: result.ok ? normalizeJson(result.output) : null,
    })
    if (!result.ok) {
      diagnostics.push(
        diagnostic(
          "OPENAPI_SNAPSHOT_FAILED",
          "warning",
          `Could not capture the OpenAPI interface of shot "${shot}".`,
          { details: { shot, output: result.output.slice(-1500) } },
        ),
      )
    }
  }

  const captured = interfaces.filter((i) => i.snapshot !== null)
  const interfaceEqual =
    captured.length === shotWorkspaces.length &&
    new Set(captured.map((i) => i.snapshot)).size <= 1

  if (shotWorkspaces.length > 1 && captured.length === shotWorkspaces.length) {
    if (interfaceEqual) {
      diagnostics.push(
        diagnostic(
          "INTERFACE_IDENTICAL",
          "info",
          `All shots expose an identical normalized OpenAPI interface.`,
          {},
        ),
      )
    } else {
      diagnostics.push(
        diagnostic(
          "INTERFACE_DIVERGENT",
          "error",
          `Independent generations expose different interfaces — the golden rule is violated. Pin the diverging behavior in the spec/compiler.`,
          {
            details: {
              shots: interfaces.map((i) => ({
                shot: i.shot,
                snapshot: i.snapshot?.slice(0, 2000),
              })),
            },
          },
        ),
      )
    }
  }

  return {
    ok: allConformant && (shotWorkspaces.length === 1 || interfaceEqual),
    shots,
    interfaces,
    interfaceEqual,
    diagnostics,
    totalCostUsd,
  }
}

/** Canonicalize captured JSON (strips trailing non-JSON noise). */
export function normalizeJson(output: string): string | null {
  const start = output.indexOf("{")
  const end = output.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    return JSON.stringify(JSON.parse(output.slice(start, end + 1)))
  } catch {
    return null
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
