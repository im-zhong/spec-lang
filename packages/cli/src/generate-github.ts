import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import type { AgentExecutionEnvironment, SpecIR } from "@spec/core"
import { stableStringify } from "@spec/compiler"
import { lowerContainers } from "@spec/container"
import {
  createGitHubGenerationPlan,
  runGitHubGeneration,
  type ShotSpec,
} from "@spec/agent"

export interface GitHubGenerateOptions {
  repoRoot: string
  runId: string
  image: string
  repository?: string
  targetDirectory?: string
  appName: string
  target: "backend" | "frontend"
  shots: number
  concurrency: number
  requiredCheck: string
  resume: boolean
  model?: string
  maxTurns?: number
  shotSpec: ShotSpec
  ir: SpecIR
}

export interface GitHubCheckout {
  repository: string
  headSha: string
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function gitFileHash(root: string, sha: string, file: string): string {
  const content = execFileSync("git", ["show", `${sha}:${file}`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
  return createHash("sha256").update(content).digest("hex")
}

function repositoryFromOrigin(root: string): string {
  const remote = git(root, ["config", "--get", "remote.origin.url"])
  const match = remote.replace(/\/+$/, "").match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i)
  if (!match?.[1]) throw new Error(`cannot infer GitHub owner/name from origin: ${remote}`)
  return match[1]
}

function normalizedRepository(value: string): string {
  return value.trim().replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "").toLowerCase()
}

/** Planning from a dirty or unpublished tree is forbidden: GitHub is truth. */
export function assertGitHubGenerationCheckout(root: string, requestedRepository?: string): GitHubCheckout {
  const repository = repositoryFromOrigin(root)
  if (requestedRepository && normalizedRepository(requestedRepository) !== normalizedRepository(repository)) {
    throw new Error(`repository mismatch: ${requestedRepository} does not match origin ${repository}`)
  }
  const changes = git(root, ["status", "--porcelain", "--untracked-files=all"])
  if (changes) throw new Error("GitHub generation requires a completely clean checkout, including no untracked files")
  const headSha = git(root, ["rev-parse", "HEAD"])
  const published = git(root, ["ls-remote", "--heads", "--tags", "origin"])
    .split("\n")
    .some((line) => line.trim().split(/\s+/)[0] === headSha)
  if (!published) throw new Error(`HEAD ${headSha} is not published to origin; push it before generation`)
  return { repository, headSha }
}

function hashFiles(root: string, files: string[]): string {
  const hash = createHash("sha256")
  for (const file of [...files].sort()) {
    hash.update(file)
    const absolute = path.join(root, file)
    hash.update(fs.existsSync(absolute) ? fs.readFileSync(absolute) : "<missing>")
  }
  return hash.digest("hex")
}

function environment(root: string, image: string): AgentExecutionEnvironment {
  return {
    image,
    devcontainerHash: hashFiles(root, [
      ".devcontainer/devcontainer.json",
      ".devcontainer/Dockerfile",
      ".devcontainer/package.json",
      ".devcontainer/package-lock.json",
    ]),
    toolchainLockHash: hashFiles(root, ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]),
  }
}

function shotTarget(options: GitHubGenerateOptions, index: number): string {
  const base = options.targetDirectory ?? `products/${options.appName.toLowerCase()}/${options.target}`
  return options.shots === 1 ? base : `${base}-shot-${index + 1}`
}

function assertTargetIsTracked(root: string, target: string): void {
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", target], { cwd: root, stdio: "ignore" })
  } catch {
    return
  }
  throw new Error(`generation target ${target} is ignored by Git; GitHub cannot use ignored local output as durable state`)
}

export async function runGitHubGenerate(options: GitHubGenerateOptions): Promise<boolean> {
  const checkout = assertGitHubGenerationCheckout(options.repoRoot, options.repository)
  const containerPlan = lowerContainers(options.ir)
  const finalMaterializations = containerPlan.containers.length === 0 ? [] : [{
    id: "containers",
    objective: "materialize compiler-owned OCI artifacts",
    files: containerPlan.files,
    commands: containerPlan.containers.flatMap((container) =>
      Object.keys(container.verification.tests).sort().map((file) => `node --check ${JSON.stringify(file)}`),
    ),
    specNodeIds: containerPlan.containers.map((container) => container.nodeId).sort(),
  }]
  const parallelShots = Math.min(options.shots, options.concurrency)
  const perShotConcurrency = Math.max(1, Math.floor(options.concurrency / parallelShots))
  const shots: Array<{ report: Awaited<ReturnType<typeof runGitHubGeneration>>; target: string; sinkSha?: string }> = []
  let nextShot = 0
  const runShot = async (index: number) => {
    const shot = `shot-${index + 1}`
    const runId = options.shots === 1 ? options.runId : `${options.runId}-${shot}`
    const target = shotTarget(options, index)
    assertTargetIsTracked(options.repoRoot, target)
    const plan = createGitHubGenerationPlan({
      shot: options.shotSpec,
      runId,
      repository: checkout.repository,
      rootBaseSha: checkout.headSha,
      targetDirectory: target,
      environment: environment(options.repoRoot, options.image),
      requiredChecks: [options.requiredCheck],
      finalMaterializations,
    })
    const localPlan = path.join(options.repoRoot, ".spec", "generation", runId, "plan.json")
    fs.mkdirSync(path.dirname(localPlan), { recursive: true })
    fs.writeFileSync(localPlan, stableStringify(plan) + "\n", "utf8")
    process.stdout.write(`⟳ ${shot}: ${plan.tasks.length} generator nodes → branches/containers/PRs\n`)
    const report = await runGitHubGeneration(plan, {
      repoRoot: options.repoRoot,
      concurrency: perShotConcurrency,
      resume: options.resume,
      model: options.model,
      maxTurns: options.maxTurns,
      onTaskStart: (taskId) => process.stdout.write(`  ⟳ ${shot}/${taskId}\n`),
      onTaskEnd: (taskId, ok, sha) => process.stdout.write(`  ${ok ? "✓" : "✗"} ${shot}/${taskId}${sha ? ` ${sha.slice(0, 12)}` : ""}\n`),
    })
    const localResult = path.join(options.repoRoot, ".spec", "generation", runId, "result.json")
    fs.writeFileSync(localResult, stableStringify(report) + "\n", "utf8")
    process.stdout.write(`${report.ok ? "✓" : "✗"} ${shot}: plan ${report.planRef} @ ${report.planCommitSha.slice(0, 12)}\n`)
    const sink = plan.tasks.find((candidate) => !plan.tasks.some((task) => task.dependsOn.includes(candidate.id)))
    const sinkSha = report.tasks.find((task) => task.taskId === sink?.id)?.headSha
    shots[index] = { report, target, ...(sinkSha ? { sinkSha } : {}) }
  }
  await Promise.all(Array.from({ length: parallelShots }, async () => {
    while (nextShot < options.shots) {
      const index = nextShot++
      await runShot(index)
    }
  }))
  const reportsOk = shots.every(({ report }) => report.ok)
  if (!reportsOk || options.shots === 1) return reportsOk

  const evidenceFiles = options.shotSpec.evidenceFiles ?? []
  if (evidenceFiles.length === 0) {
    process.stderr.write("✗ Multiple shots declared no compiler-owned equality evidence\n")
    return false
  }
  const evidence = shots.map(({ target, sinkSha }, index) => {
    if (!sinkSha) throw new Error(`shot-${index + 1} has no durable sink commit`)
    return Object.fromEntries(evidenceFiles.map((file) => [file, gitFileHash(options.repoRoot, sinkSha, path.posix.join(target, file))]))
  })
  const equal = evidenceFiles.every((file) => new Set(evidence.map((shot) => shot[file])).size === 1)
  process.stdout.write(equal
    ? `✓ ${options.shots} GitHub-generated shots have byte-identical compiler evidence\n`
    : `✗ GitHub-generated shots diverge in compiler evidence; fix the specification/blueprint and regenerate\n`)
  return equal
}
