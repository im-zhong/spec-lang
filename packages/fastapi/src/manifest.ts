/**
 * Test manifest — coverage as a compile-time fact, not a memory.
 *
 * The clause table already enumerates every declared contract element; the
 * manifest answers, per clause, WHICH machine tests cover it and WHERE
 * they run:
 *
 *   inLoop    — the node oracle (loop evidence + acceptance, round 1)
 *   terminal  — the single-shot conformance suite after the sink
 *
 * Every claim is derived from what the generators ACTUALLY emit: in-loop
 * coverage names the real compiled probe labels (behaviorTripleLabels) or
 * the node oracle's own checks; terminal coverage names the conformance
 * artifacts. Nothing is claimed by naming convention alone.
 *
 * Gates (coverageDiagnostics): an oracle-verified clause with no covering
 * test anywhere is a compile ERROR (declared-but-untested); terminal-only
 * coverage is surfaced as info (a defect there detonates at the final
 * judgment instead of in-loop). Review-kind clauses are covered by the
 * read-only reviewer by design and never gated.
 */
import type { Diagnostic } from "@spec/core"
import type { BackendBlueprint } from "./blueprint"
import type { DagTask } from "./dag"
import { behaviorTripleLabels } from "./oracle"

export interface CoverageEntry {
  /** Node-oracle coverage: the oracle file and/or real probe labels. */
  inLoop: string[]
  /** Terminal conformance coverage. */
  terminal: string[]
}

export interface TestManifest {
  coverage: Record<string, CoverageEntry>
}

function add(map: Map<string, CoverageEntry>, clauseId: string, where: "inLoop" | "terminal", id: string): void {
  const entry = map.get(clauseId) ?? { inLoop: [], terminal: [] }
  if (!entry[where].includes(id)) entry[where].push(id)
  map.set(clauseId, entry)
}

/** Derive the coverage map from the plan. Pure function of bp + tasks. */
export function deriveTestManifest(bp: BackendBlueprint, tasks: DagTask[]): TestManifest {
  const map = new Map<string, CoverageEntry>()

  for (const task of tasks) {
    const oracle = `node-oracle:${task.id}`
    const labels = behaviorTripleLabels(bp, task.id)
    const isRouter = task.id.startsWith("router:")
    const isInfra = ["cache", "messaging", "blob"].includes(task.kind)

    for (const clause of task.clauses) {
      const id = clause.id

      if (!isRouter && !isInfra) {
        // Static nodes (project/models/database/schemas/security/app):
        // their whole clause table is machine-checked by the node oracle.
        add(map, id, "inLoop", oracle)
        if (task.kind === "schemas" && id.includes(":bound:")) {
          add(map, id, "terminal", "conformance test_contract.py (bound probes)")
        }
        continue
      }

      if (isInfra) {
        // Shape clauses by the oracle's structural checks; behavior/adapter
        // clauses by the fake-client probes the runner now executes.
        add(map, id, "inLoop", oracle)
        if (["adapter", "selector", "behavior"].includes(clause.kind)) {
          add(map, id, "inLoop", `node-behavior:${task.kind}`)
        }
        add(map, id, "terminal", `conformance test_infrastructure.py (test_${task.kind}_contract)`)
        continue
      }

      // Router nodes: map each clause to the probes that actually exist.
      if (id.startsWith("route:")) {
        add(map, id, "inLoop", oracle)
        const routeId = id.slice("route:".length).split(":")[0]
        const operation = routeId.split(" ")[1] === "" ? undefined : bp.routes.find((r) => r.id === routeId)?.operation
        const stem = operation === "transition" ? `transition:${routeId}` : `${operation ?? ""}:${routeId}`
        for (const label of labels) {
          if (label === stem || label.startsWith(`${stem}`) || (operation !== undefined && label.endsWith(`:${routeId}`))) {
            add(map, id, "inLoop", `triple ${label}`)
          }
        }
        add(map, id, "terminal", "conformance test_contract.py")
        continue
      }
      if (id.startsWith("invariant:")) {
        add(map, id, "inLoop", oracle)
        const name = id.slice("invariant:".length)
        for (const label of labels) {
          if (label === `invariant:${name}` || label === `invariant-tighten:${name}`) {
            add(map, id, "inLoop", `triple ${label}`)
          }
        }
        add(map, id, "terminal", `conformance test_contract.py (test_invariant_${name.replace(/[^a-zA-Z0-9_]/g, "_")})`)
        continue
      }
      if (id.startsWith("example:")) {
        for (const label of labels) {
          if (label === id) add(map, id, "inLoop", `triple ${label}`)
        }
        add(map, id, "terminal", "conformance test_examples.py")
        continue
      }
      if (id.startsWith("import:")) {
        // The oracle scans the module source and the route table.
        add(map, id, "inLoop", oracle)
        continue
      }
      if (clause.kind === "error") {
        const routeId = id.slice("route:".length).split(":")[0]
        for (const label of labels) {
          if (label.startsWith("create-conflict:") || label.startsWith("create-dangling:")) {
            add(map, id, "inLoop", `triple ${label}`)
          }
        }
        add(map, id, "terminal", "conformance test_contract.py")
        continue
      }
      if (clause.kind === "serialization") {
        // Echo probes exercise the declared serialization per key; the
        // exact key set is asserted terminally.
        for (const label of labels) {
          if (/^(create|get|list|update|delete|count|register|me|login):/.test(label)) {
            add(map, id, "inLoop", `triple ${label}`)
          }
        }
        add(map, id, "terminal", "conformance test_contract.py")
        continue
      }
      if (clause.kind === "transition") {
        const routeId = id.slice("route:".length).split(":")[0]
        for (const label of labels) {
          if (label.startsWith(`transition:${routeId}`)) add(map, id, "inLoop", `triple ${label}`)
        }
        add(map, id, "terminal", "conformance test_contract.py")
        continue
      }
      add(map, id, "inLoop", oracle)
    }
  }

  const coverage: Record<string, CoverageEntry> = {}
  for (const key of [...map.keys()].sort()) {
    const entry = map.get(key)!
    coverage[key] = { inLoop: [...entry.inLoop].sort(), terminal: [...entry.terminal].sort() }
  }
  return { coverage }
}

/** Compile gate over the manifest: oracle clauses must be covered. */
export function coverageDiagnostics(
  manifest: TestManifest,
  clauses: Array<{ id: string; verification: string }>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  for (const clause of clauses) {
    if (clause.verification === "review") continue
    const entry = manifest.coverage[clause.id]
    if (entry === undefined || (entry.inLoop.length === 0 && entry.terminal.length === 0)) {
      diagnostics.push({
        code: "TEST_COVERAGE_MISSING",
        level: "error",
        message: `Clause ${JSON.stringify(clause.id)} is machine-verified but no oracle or conformance test covers it — add a probe or mark it review.`,
      })
    } else if (entry.inLoop.length === 0) {
      diagnostics.push({
        code: "TEST_COVERAGE_TERMINAL_ONLY",
        level: "info",
        message: `Clause ${JSON.stringify(clause.id)} is only judged at terminal conformance — a defect there detonates at the single-shot judgment, not in-loop.`,
      })
    }
  }
  return diagnostics
}
