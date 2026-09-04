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
  target: "backend" | "frontend" | "workspace"
  shots: number
  concurrency: number
  requiredCheck: string
  resume: boolean
  model: string
  effort: "low" | "medium" | "high" | "xhigh" | "max"
  maxTurns: number
  shotSpec: ShotSpec
  ir: SpecIR
}

export interface GitHubCheckout {
  repository: string
  headSha: string
}

export interface TemporaryShotRepository extends GitHubCheckout {
  localRoot: string
  defaultBranch: string
  created: boolean
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function gh(root: string, args: string[], stdio: "pipe" | "ignore" = "pipe"): string {
  const output = execFileSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", stdio, stdio],
  })
  return typeof output === "string" ? output.trim() : ""
}

function gitFileHash(root: string, sha: string, file: string): string {
  const content = execFileSync("git", ["show", `${sha}:${file}`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
  return createHash("sha256").update(content).digest("hex")
}

function repositoryFromOrigin(root: string): string {
  const remote = git(root, ["config", "--get", "remote.origin.url"])
  const normalized = remote.replace(/\/+$/, "")
  const match = normalized.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i)
    ?? normalized.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i)
    ?? normalized.match(/^ssh:\/\/git@ssh\.github\.com:443\/([^/]+\/[^/]+?)(?:\.git)?$/i)
  if (!match?.[1]) throw new Error(`cannot infer GitHub owner/name from origin: ${remote}`)
  return match[1]
}

function normalizedRepository(value: string): string {
  return value.trim().replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "").toLowerCase()
}

/**
 * Use GitHub's SSH endpoint on port 443 so execution keeps SSH-key write
 * permissions (including workflow publication) without depending on port 22.
 */
export function temporaryShotRepositorySshUrl(repository: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("temporary repository must use a GitHub-safe owner/name")
  }
  return `ssh://git@ssh.github.com:443/${repository}.git`
}

const GITHUB_SSH_COMMAND = "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

function configureGitHubSshRemote(localRoot: string, repository: string): void {
  git(localRoot, ["remote", "set-url", "origin", temporaryShotRepositorySshUrl(repository)])
  git(localRoot, ["config", "--local", "core.sshCommand", GITHUB_SSH_COMMAND])
}

function repositoryExists(root: string, repository: string): boolean {
  // A failed `gh repo view` is ambiguous: only GitHub's not-found response
  // may be read as absence. Transport failures are retried with backoff and
  // then thrown, so a flaky connection can never misclassify an existing
  // temporary repository as missing.
  for (let attempt = 1; ; attempt++) {
    let stderr = ""
    try {
      execFileSync("gh", ["repo", "view", repository, "--json", "nameWithOwner"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
      })
      return true
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? (error instanceof Error ? error.message : error))
      if (/HTTP 404|Could not resolve to a Repository|does not exist/i.test(stderr)) return false
      if (attempt >= 3) {
        throw new Error(`cannot verify repository ${repository}: ${stderr.trim()}`)
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000 * attempt)
    }
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

/** Stable remote identity: one repository, never one branch, per shot. */
export function temporaryShotRepositoryName(
  owner: string,
  base: string,
  runId: string,
  shot: string,
): string {
  const suffix = `-${slug(runId)}-${slug(shot)}`
  const maxBaseLength = 100 - suffix.length
  if (maxBaseLength < 1) throw new Error("run id and shot name are too long to form a GitHub repository name")
  const safeBase = slug(base).slice(0, maxBaseLength).replace(/[-.]+$/g, "")
  const safeOwner = owner.trim()
  if (!safeBase || !/^[A-Za-z0-9_.-]+$/.test(safeOwner)) {
    throw new Error("temporary repository owner/base must contain GitHub-safe characters")
  }
  return `${safeOwner}/${safeBase}${suffix}`
}

/** Stable and disjoint local checkout root paired with a shot repository. */
export function temporaryShotLocalRoot(sourceRoot: string, runId: string, shot: string): string {
  const safeRun = slug(runId)
  const safeShot = slug(shot)
  if (!safeRun || !safeShot) throw new Error("run id and shot name must form safe local paths")
  return path.join(sourceRoot, ".spec", "generation", safeRun, "repositories", safeShot)
}

function repositoryPrefix(root: string, requested: string | undefined, appName: string, target: string): { owner: string; base: string } {
  if (requested) {
    const parts = requested.trim().replace(/\.git$/i, "").split("/")
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error("--repository must use owner/base form; each shot appends its run and shot id")
    }
    return { owner: parts[0], base: parts[1] }
  }
  const owner = gh(root, ["api", "user", "--jq", ".login"])
  return { owner, base: `spec-${appName}-${target}` }
}

/**
 * This workflow makes the required GitHub check meaningful: it reads the
 * immutable compiler plan for the PR's run/task and executes that task's
 * acceptance commands in the exact digest-pinned agent image.
 */
export const TEMPORARY_REPOSITORY_WORKFLOW = `name: spec-generation

on:
  pull_request:

permissions:
  contents: read
  packages: read

jobs:
  verify:
    name: spec-generation
    runs-on: ubuntu-24.04
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          fetch-depth: 0

      - name: Resolve immutable compiler acceptance
        env:
          HEAD_BRANCH: \${{ github.head_ref }}
        run: |
          set -eu
          rest="\${HEAD_BRANCH#spec/generate/}"
          run_id="\${rest%%/*}"
          task_id="\${rest##*/}"
          test -n "\$run_id"
          test -n "\$task_id"
          git fetch --no-tags origin "refs/heads/spec/generate/\$run_id/plan:refs/remotes/origin/spec-plan"
          git show refs/remotes/origin/spec-plan:plan.json > /tmp/spec-plan.json
          jq -e --arg task "\$task_id" '.tasks[] | select(.id == \$task)' /tmp/spec-plan.json > /tmp/spec-task.json
          jq -r '.acceptance.commands[]' /tmp/spec-task.json > /tmp/spec-acceptance.sh
          jq -r '.workingDirectory // ""' /tmp/spec-task.json > /tmp/spec-workdir
          jq -r '.environment.image' /tmp/spec-plan.json > /tmp/spec-image
          test -s /tmp/spec-acceptance.sh

      - name: Run acceptance in pinned image
        env:
          GHCR_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          set -eu
          image="\$(cat /tmp/spec-image)"
          workdir="\$(cat /tmp/spec-workdir)"
          printf '%s' "\$GHCR_TOKEN" | docker login ghcr.io --username "\$GITHUB_ACTOR" --password-stdin
          docker pull "\$image"
          docker run --rm -i \\
            --user "\$(id -u):\$(id -g)" \\
            --env HOME=/tmp/spec-home \\
            --env UV_CACHE_DIR=/tmp/spec-home/.cache/uv \\
            --env UV_PYTHON_CACHE_DIR=/tmp/spec-home/.cache/uv \\
            --tmpfs /tmp:rw,nosuid,exec,size=4g \\
            --mount "type=bind,source=\$GITHUB_WORKSPACE,target=/workspace" \\
            --workdir "/workspace/\$workdir" \\
            "\$image" sh -s < /tmp/spec-acceptance.sh
`

function assertLocalRepository(localRoot: string, repository: string): void {
  const actual = normalizedRepository(repositoryFromOrigin(localRoot))
  if (actual !== normalizedRepository(repository)) {
    throw new Error(`temporary checkout ${localRoot} points at ${actual}, expected ${repository}`)
  }
}

export function prepareTemporaryShotRepository(input: {
  sourceRoot: string
  repository: string
  localRoot: string
  runId: string
  shot: string
  resume: boolean
}): TemporaryShotRepository {
  const { sourceRoot, repository, localRoot, runId, shot, resume } = input
  const exists = repositoryExists(sourceRoot, repository)
  if (!resume && exists) {
    throw new Error(`temporary repository ${repository} already exists; choose a new --run-id or use --resume`)
  }
  if (resume && !exists) {
    throw new Error(`cannot resume: temporary repository ${repository} does not exist`)
  }

  if (!exists) {
    gh(sourceRoot, [
      "repo", "create", repository,
      "--private", "--add-readme", "--disable-issues", "--disable-wiki",
      "--description", `Disposable spec generation target for ${runId}/${shot}`,
    ])
  }

  if (!fs.existsSync(path.join(localRoot, ".git"))) {
    if (fs.existsSync(localRoot) && fs.readdirSync(localRoot).length > 0) {
      throw new Error(`temporary checkout path is non-empty and not a Git repository: ${localRoot}`)
    }
    fs.mkdirSync(path.dirname(localRoot), { recursive: true })
    execFileSync("git", ["clone", "--origin", "origin", temporaryShotRepositorySshUrl(repository), localRoot], {
      cwd: sourceRoot,
      env: { ...process.env, GIT_SSH_COMMAND: GITHUB_SSH_COMMAND },
      stdio: ["ignore", "pipe", "pipe"],
    })
  }
  assertLocalRepository(localRoot, repository)
  configureGitHubSshRemote(localRoot, repository)

  const defaultBranch = gh(sourceRoot, ["repo", "view", repository, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])
  if (!defaultBranch) throw new Error(`temporary repository ${repository} has no default branch`)

  const workflow = path.join(localRoot, ".github", "workflows", "spec-generation.yml")
  if (!resume) {
    fs.mkdirSync(path.dirname(workflow), { recursive: true })
    fs.writeFileSync(workflow, TEMPORARY_REPOSITORY_WORKFLOW, "utf8")
    git(localRoot, ["add", ".github/workflows/spec-generation.yml"])
    execFileSync("git", [
      "-c", "user.name=spec generator",
      "-c", "user.email=spec-generator@invalid.local",
      "commit", "-m", `chore: bootstrap temporary spec repository for ${runId}/${shot}`,
    ], { cwd: localRoot, stdio: ["ignore", "pipe", "pipe"] })
    git(localRoot, ["push", "origin", `HEAD:${defaultBranch}`])
  } else {
    git(localRoot, ["fetch", "origin", defaultBranch])
    git(localRoot, ["checkout", "--detach", `origin/${defaultBranch}`])
    if (!fs.existsSync(workflow)) throw new Error(`temporary repository ${repository} is missing its compiler-owned verification workflow`)
  }

  const headSha = git(localRoot, ["rev-parse", "HEAD"])
  const published = git(localRoot, ["ls-remote", "--heads", "origin", `refs/heads/${defaultBranch}`])
    .split("\n")
    .some((line) => line.trim().split(/\s+/)[0] === headSha)
  if (!published) throw new Error(`temporary repository bootstrap ${headSha} is not published to ${repository}`)
  return { repository, localRoot, defaultBranch, headSha, created: !exists }
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

function environment(
  root: string,
  image: string,
  agent: AgentExecutionEnvironment["agent"],
): AgentExecutionEnvironment {
  return {
    image,
    devcontainerHash: hashFiles(root, [
      ".devcontainer/devcontainer.json",
      ".devcontainer/Dockerfile",
      ".devcontainer/package.json",
      ".devcontainer/package-lock.json",
    ]),
    toolchainLockHash: hashFiles(root, ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]),
    agent,
  }
}

function shotTarget(options: GitHubGenerateOptions): string {
  const base = options.targetDirectory ?? `products/${options.appName.toLowerCase()}/${options.target}`
  return base
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
  const prefix = repositoryPrefix(options.repoRoot, options.repository, options.appName, options.target)
  if (options.requiredCheck !== "spec-generation") {
    throw new Error('temporary repositories expose the compiler-owned required check "spec-generation"')
  }
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
  const shots: Array<{
    report: Awaited<ReturnType<typeof runGitHubGeneration>>
    repository: TemporaryShotRepository
    target: string
    sinkSha?: string
  }> = []
  const repositories = Array.from({ length: options.shots }, (_, index) => {
    const shot = `shot-${index + 1}`
    const runId = options.shots === 1 ? options.runId : `${options.runId}-${shot}`
    const remote = temporaryShotRepositoryName(prefix.owner, prefix.base, options.runId, shot)
    const localRoot = temporaryShotLocalRoot(options.repoRoot, options.runId, shot)
    return prepareTemporaryShotRepository({
      sourceRoot: options.repoRoot,
      repository: remote,
      localRoot,
      runId,
      shot,
      resume: options.resume,
    })
  })
  if (new Set(repositories.map((item) => normalizedRepository(item.repository))).size !== options.shots ||
      new Set(repositories.map((item) => path.resolve(item.localRoot))).size !== options.shots) {
    throw new Error("generator defect: shots did not receive distinct remote repositories and local roots")
  }

  let nextShot = 0
  const runShot = async (index: number) => {
    const shot = `shot-${index + 1}`
    const runId = options.shots === 1 ? options.runId : `${options.runId}-${shot}`
    const repository = repositories[index]
    const target = shotTarget(options)
    assertTargetIsTracked(repository.localRoot, target)
    const plan = createGitHubGenerationPlan({
      shot: options.shotSpec,
      runId,
      repository: repository.repository,
      rootBaseSha: repository.headSha,
      defaultBranch: repository.defaultBranch,
      targetDirectory: target,
      environment: environment(options.repoRoot, options.image, {
        model: options.model,
        effort: options.effort,
        maxTurns: options.maxTurns,
        maxConcurrency: perShotConcurrency,
      }),
      requiredChecks: [options.requiredCheck],
      finalMaterializations,
    })
    const localPlan = path.join(options.repoRoot, ".spec", "generation", runId, "plan.json")
    fs.mkdirSync(path.dirname(localPlan), { recursive: true })
    fs.writeFileSync(localPlan, stableStringify(plan) + "\n", "utf8")
    process.stdout.write(`⟳ ${shot}: ${repository.repository} @ ${repository.localRoot}\n`)
    process.stdout.write(`  ${plan.tasks.length} generator nodes → branches/containers/PRs\n`)
    const report = await runGitHubGeneration(plan, {
      repoRoot: repository.localRoot,
      worktreeRoot: path.join(options.repoRoot, ".spec", "generation", options.runId, "worktrees", shot),
      concurrency: perShotConcurrency,
      resume: options.resume,
      model: options.model,
      effort: options.effort,
      maxTurns: options.maxTurns,
      onTaskStart: (taskId) => process.stdout.write(`  ⟳ ${shot}/${taskId}\n`),
      onTaskEnd: (taskId, ok, sha) => process.stdout.write(`  ${ok ? "✓" : "✗"} ${shot}/${taskId}${sha ? ` ${sha.slice(0, 12)}` : ""}\n`),
    })
    const localResult = path.join(options.repoRoot, ".spec", "generation", runId, "result.json")
    fs.writeFileSync(localResult, stableStringify({
      repository: repository.repository,
      localRoot: repository.localRoot,
      targetDirectory: target,
      report,
    }) + "\n", "utf8")
    process.stdout.write(`${report.ok ? "✓" : "✗"} ${shot}: plan ${report.planRef} @ ${report.planCommitSha.slice(0, 12)}\n`)
    const sink = plan.tasks.find((candidate) => !plan.tasks.some((task) => task.dependsOn.includes(candidate.id)))
    const sinkSha = report.tasks.find((task) => task.taskId === sink?.id)?.headSha
    shots[index] = { report, repository, target, ...(sinkSha ? { sinkSha } : {}) }
  }
  const workers = await Promise.allSettled(Array.from({ length: parallelShots }, async () => {
    while (nextShot < options.shots) {
      const index = nextShot++
      await runShot(index)
    }
  }))
  const failures = workers.filter((item): item is PromiseRejectedResult => item.status === "rejected")
  if (failures.length > 0) {
    throw new Error(`shot execution failed: ${failures.map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason)).join("; ")}`)
  }
  const reportsOk = shots.every(({ report }) => report.ok)
  if (!reportsOk || options.shots === 1) return reportsOk

  const evidenceFiles = options.shotSpec.evidenceFiles ?? []
  if (evidenceFiles.length === 0) {
    process.stderr.write("✗ Multiple shots declared no compiler-owned equality evidence\n")
    return false
  }
  const evidence = shots.map(({ repository, target, sinkSha }, index) => {
    if (!sinkSha) throw new Error(`shot-${index + 1} has no durable sink commit`)
    return Object.fromEntries(evidenceFiles.map((file) => [file, gitFileHash(repository.localRoot, sinkSha, path.posix.join(target, file))]))
  })
  const equal = evidenceFiles.every((file) => new Set(evidence.map((shot) => shot[file])).size === 1)
  process.stdout.write(equal
    ? `✓ ${options.shots} GitHub-generated shots have byte-identical compiler evidence\n`
    : `✗ GitHub-generated shots diverge in compiler evidence; fix the specification/blueprint and regenerate\n`)
  return equal
}
