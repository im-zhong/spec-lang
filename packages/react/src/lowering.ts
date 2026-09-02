import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { stableStringify, type AgentTask, type SpecIR } from "@spec/core"
import { buildFrontendBlueprint, type FrontendBlueprint } from "./blueprint"
import { buildFrontendConformanceSuite, type FrontendConformanceFiles } from "./conformance"
import { buildFrontendDag, type FrontendDag } from "./dag"
import { buildRuntimeFiles } from "./runtime"
import { frontendVerification, type FrontendVerificationPlan } from "./verify"

export interface FrontendGenerationPlan {
  blueprint: FrontendBlueprint
  dag: FrontendDag
  agentTasks: AgentTask[]
  seedFiles: Record<string, string>
  conformance: FrontendConformanceFiles
  verification: FrontendVerificationPlan
  stable: string
}

export function planFrontendGeneration(ir: SpecIR): FrontendGenerationPlan {
  const blueprint = buildFrontendBlueprint(ir)
  const dag = buildFrontendDag(blueprint, ir)
  const seedFiles = buildRuntimeFiles(blueprint)
  const conformance = buildFrontendConformanceSuite(blueprint)
  const verification = frontendVerification(blueprint)
  const agentTasks: AgentTask[] = dag.tasks.map((task) => ({
    id: task.id,
    type: "generate",
    input: { scope: task.scope, dependsOn: task.dependsOn },
    constraints: [
      { kind: "frontend-blueprint", value: blueprint.version },
      { kind: "runtime", value: blueprint.contract.rendering },
      { kind: "no-repair", value: "first verification is final" },
    ],
    context: { specNodeIds: task.specNodeIds },
  }))
  return {
    blueprint,
    dag,
    agentTasks,
    seedFiles,
    conformance,
    verification,
    stable: stableStringify({ blueprint, dag, seedFiles, conformance: conformance.files, verification }),
  }
}

export interface FrontendShotEvidence {
  shot: string
  /** Per-screen layout captures, file name → sha256 (null when missing). */
  layoutSha256s: Record<string, string | null>
  behaviorImageSha256: string | null
  behaviorSnapshot: string | null
}

export interface FrontendEqualityReport {
  ok: boolean
  layoutEqual: boolean
  behaviorImageEqual: boolean
  behaviorEqual: boolean
  shots: FrontendShotEvidence[]
}

function sha(file: string): string | null {
  if (!fs.existsSync(file)) return null
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

export function compareFrontendShots(workspaces: Array<{ shot: string; workspace: string }>): FrontendEqualityReport {
  const shots = workspaces.map(({ shot, workspace }) => {
    const behaviorPath = path.join(workspace, "conformance-output/behavior.json")
    let behaviorSnapshot: string | null = null
    if (fs.existsSync(behaviorPath)) {
      try { behaviorSnapshot = JSON.stringify(JSON.parse(fs.readFileSync(behaviorPath, "utf8"))) } catch { behaviorSnapshot = null }
    }
    const outputDir = path.join(workspace, "conformance-output")
    const layoutFiles = fs.existsSync(outputDir)
      ? fs.readdirSync(outputDir).filter((file) => /^layout-\d+\.png$/.test(file)).sort()
      : []
    const layoutSha256s: Record<string, string | null> = {}
    for (const file of layoutFiles) layoutSha256s[file] = sha(path.join(outputDir, file))
    return {
      shot,
      layoutSha256s,
      behaviorImageSha256: sha(path.join(outputDir, "behavior.png")),
      behaviorSnapshot,
    }
  })
  const equal = (values: Array<string | null>) => values.length >= 2 && values.every((value) => value !== null) && new Set(values).size === 1
  const layoutKey = (shot: FrontendShotEvidence) => JSON.stringify(shot.layoutSha256s)
  const layoutEqual =
    shots.length >= 2 &&
    shots.every((shot) => Object.keys(shot.layoutSha256s).length > 0) &&
    shots.every((shot) => Object.values(shot.layoutSha256s).every((value) => value !== null)) &&
    new Set(shots.map(layoutKey)).size === 1
  const behaviorImageEqual = equal(shots.map((shot) => shot.behaviorImageSha256))
  const behaviorEqual = equal(shots.map((shot) => shot.behaviorSnapshot))
  return { ok: layoutEqual && behaviorImageEqual && behaviorEqual, layoutEqual, behaviorImageEqual, behaviorEqual, shots }
}
