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
  /** Compiler-owned deterministic behavior probe per shot. */
  behaviors: Array<{ shot: string; snapshot: string | null }>
  behaviorEqual: boolean
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

  // Shots are INDEPENDENT generations in separate workspaces — run them
  // in parallel. (Tasks within a shot stay sequential: two agents must
  // never write the same workspace concurrently.)
  const shotReports = await Promise.all(
    shotWorkspaces.map(({ shot, workspace }) => runShot(shot, workspace, spec, options)),
  )
  for (const report of shotReports) {
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
      `${python} -W ignore -c ${shellQuote(OPENAPI_SNIPPET)}`,
      workspace,
      "openapi-snapshot",
      120_000,
    )
    const snapshot = result.ok ? normalizeJson(result.output) : null
    interfaces.push({ shot, snapshot })
    if (!result.ok) {
      diagnostics.push(
        diagnostic(
          "OPENAPI_SNAPSHOT_FAILED",
          "warning",
          `Could not capture the OpenAPI interface of shot "${shot}".`,
          { details: { shot, output: result.output.slice(-1500) } },
        ),
      )
    } else if (snapshot === null) {
      // An exit-0 capture whose output is not parseable JSON must never
      // silently null the snapshot: that turns an unexplained capture
      // failure into a false "golden rule violated" verdict.
      diagnostics.push(
        diagnostic(
          "OPENAPI_SNAPSHOT_UNPARSEABLE",
          "error",
          `The OpenAPI capture of shot "${shot}" exited 0 but printed no parseable JSON — treating the interface as uncaptured. Re-run generation; if it reproduces, the capture contract is broken.`,
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

  /* Cross-shot behavior equality: HTTP interface plus cache, messaging,
   * and blob probes generated from the same blueprint. */
  const behaviors: RepeatabilityReport["behaviors"] = []
  for (const { shot, workspace } of shotWorkspaces) {
    const python = options.pythonCommand
      ? options.pythonCommand(workspace)
      : `${workspace}/.venv/bin/python`
    const result = await runCommand(
      `${python} -W ignore conformance/behavior_snapshot.py`,
      workspace,
      "behavior-snapshot",
      120_000,
    )
    const snapshot = result.ok ? normalizeJson(result.output) : null
    behaviors.push({ shot, snapshot })
    if (!result.ok) {
      diagnostics.push(
        diagnostic(
          "BEHAVIOR_SNAPSHOT_FAILED",
          "warning",
          `Could not capture the compiler-owned behavior snapshot of shot "${shot}".`,
          { details: { shot, output: result.output.slice(-1500) } },
        ),
      )
    } else if (snapshot === null) {
      diagnostics.push(
        diagnostic(
          "BEHAVIOR_SNAPSHOT_UNPARSEABLE",
          "error",
          `The behavior capture of shot "${shot}" exited 0 but printed no parseable JSON — treating the behavior as uncaptured. Re-run generation; if it reproduces, the capture contract is broken.`,
          { details: { shot, output: result.output.slice(-1500) } },
        ),
      )
    }
  }
  const capturedBehaviors = behaviors.filter((item) => item.snapshot !== null)
  const behaviorEqual =
    capturedBehaviors.length === shotWorkspaces.length &&
    new Set(capturedBehaviors.map((item) => item.snapshot)).size <= 1

  if (shotWorkspaces.length > 1 && capturedBehaviors.length === shotWorkspaces.length) {
    diagnostics.push(
      behaviorEqual
        ? diagnostic(
            "BEHAVIOR_IDENTICAL",
            "info",
            "All shots produce an identical compiler-owned behavior snapshot.",
            {},
          )
        : diagnostic(
            "BEHAVIOR_DIVERGENT",
            "error",
            "Independent generations behave differently — redesign the spec/IR/blueprint and regenerate every shot.",
            { details: { shots: behaviors } },
          ),
    )
  }

  return {
    ok:
      allConformant &&
      interfaceEqual &&
      behaviorEqual,
    shots,
    interfaces,
    interfaceEqual,
    behaviors,
    behaviorEqual,
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
