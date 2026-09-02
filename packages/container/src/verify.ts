/** Compiler-owned verification for lowered OCI container contracts. */

export interface ContainerVerificationCommand {
  name: string
  command: string
  timeoutMs: number
}

export interface ContainerVerificationPlan {
  /** Environment supplied by the GitHub/container executor, never baked in. */
  requiredEnvironment: string[]
  /** Test sources emitted by the compiler, path -> byte-stable content. */
  tests: Record<string, string>
  setup: ContainerVerificationCommand[]
  check: ContainerVerificationCommand[]
}

export interface VerificationInput {
  slug: string
  fingerprint: string
  dockerfilePath: string
  contractPath: string
  platform: string
  configTestPath: string
  runtimeTestPath: string
  attestationTestPath: string
  ociArchivePath: string
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

const CONFIG_TEST = `import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

const [contractFile, image] = process.argv.slice(2)
if (!contractFile || !image) throw new Error("usage: verify-config.mjs <runtime-contract.json> <image>")
const contract = JSON.parse(readFileSync(contractFile, "utf8"))
const inspected = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8" })
if (inspected.status !== 0) throw new Error(inspected.stderr || "docker image inspect failed")
const config = JSON.parse(inspected.stdout)[0]?.Config
if (!config) throw new Error("image has no OCI config")
const equal = (actual, expected, field) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(field + " mismatch: expected " + JSON.stringify(expected) + ", received " + JSON.stringify(actual))
  }
}
equal(config.User || "", contract.user, "User")
equal(config.WorkingDir || "", contract.workdir, "WorkingDir")
if (contract.command) equal(config.Cmd || [], contract.command, "Cmd")
if (contract.stopSignal) equal(config.StopSignal || "", contract.stopSignal, "StopSignal")
const actualEnv = Object.fromEntries((config.Env || []).map((entry) => {
  const split = entry.indexOf("=")
  return [entry.slice(0, split), entry.slice(split + 1)]
}))
for (const [key, value] of Object.entries(contract.environment)) equal(actualEnv[key], value, "Env." + key)
if (contract.port) {
  const key = String(contract.port) + "/tcp"
  if (!config.ExposedPorts?.[key]) throw new Error("missing exposed port " + key)
}
if (contract.healthcheck) {
  equal(config.Healthcheck?.Test || [], contract.healthcheck.command, "Healthcheck.Test")
  equal(config.Healthcheck?.Interval, contract.healthcheck.intervalSeconds * 1e9, "Healthcheck.Interval")
  equal(config.Healthcheck?.Timeout, contract.healthcheck.timeoutSeconds * 1e9, "Healthcheck.Timeout")
  equal(config.Healthcheck?.StartPeriod || 0, contract.healthcheck.startPeriodSeconds * 1e9, "Healthcheck.StartPeriod")
  equal(config.Healthcheck?.Retries, contract.healthcheck.retries, "Healthcheck.Retries")
}
for (const [key, value] of Object.entries(contract.labels.static)) equal(config.Labels?.[key], value, "Label." + key)
for (const key of contract.labels.requiredNonEmpty) {
  if (!config.Labels?.[key]) throw new Error("required OCI label is empty: " + key)
}
`

const RUNTIME_TEST = `import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

const [contractFile, image] = process.argv.slice(2)
if (!contractFile || !image) throw new Error("usage: verify-runtime.mjs <runtime-contract.json> <image>")
const contract = JSON.parse(readFileSync(contractFile, "utf8"))
const name = "spec-verify-" + contract.fingerprint.slice(7, 19)
const run = ["run", "--detach", "--name", name, "--user", contract.user, "--workdir", contract.workdir]
if (contract.readOnlyRootFilesystem) run.push("--read-only")
if (contract.init) run.push("--init")
if (contract.stopSignal) run.push("--stop-signal", contract.stopSignal)
for (const [key, value] of Object.entries(contract.environment)) run.push("--env", key + "=" + value)
run.push(image)
const execute = (args, allowFailure = false) => {
  const result = spawnSync("docker", args, { encoding: "utf8" })
  if (!allowFailure && result.status !== 0) throw new Error(result.stderr || ("docker " + args[0] + " failed"))
  return result
}
execute(["rm", "--force", name], true)
try {
  execute(run)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  const uid = execute(["exec", name, "id", "-u"]).stdout.trim()
  if (!/^[0-9]+$/.test(uid) || uid === "0") throw new Error("container resolves runtime user to root UID: " + uid)
  const deadline = Date.now() + (contract.healthcheck ? contract.healthcheck.acceptanceTimeoutMs : 5_000)
  let state
  do {
    const result = execute(["inspect", "--format", "{{json .State}}", name])
    state = JSON.parse(result.stdout)
    if (!state.Running) throw new Error("container stopped during startup: " + JSON.stringify(state))
    if (!contract.healthcheck || state.Health?.Status === "healthy") break
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  } while (Date.now() < deadline)
  if (contract.healthcheck && state.Health?.Status !== "healthy") throw new Error("container did not become healthy")
  execute(["stop", "--time", "10", name])
} finally {
  execute(["rm", "--force", name], true)
}
`

const ATTESTATION_TEST = `import { spawnSync } from "node:child_process"

const [archive] = process.argv.slice(2)
if (!archive) throw new Error("usage: verify-attestations.mjs <image.oci.tar>")
const extract = (file) => {
  const result = spawnSync("tar", ["-xOf", archive, file], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || ("cannot extract " + file))
  return JSON.parse(result.stdout)
}
const index = extract("index.json")
const descriptors = index.manifests || []
const attestations = descriptors.filter((item) => item.annotations?.["vnd.docker.reference.type"] === "attestation-manifest")
if (attestations.length === 0) throw new Error("OCI archive contains no attestation manifest")
const predicateTypes = []
for (const descriptor of attestations) {
  const manifest = extract("blobs/sha256/" + descriptor.digest.replace(/^sha256:/, ""))
  for (const layer of manifest.layers || []) {
    const type = layer.annotations?.["in-toto.io/predicate-type"]
    if (type) predicateTypes.push(type)
  }
}
if (!predicateTypes.some((type) => /spdx/i.test(type))) throw new Error("OCI archive has no SPDX SBOM attestation")
if (!predicateTypes.some((type) => /slsa|provenance/i.test(type))) throw new Error("OCI archive has no provenance attestation")
`

/** Build and independently inspect/run one image. No agent-authored test is trusted. */
export function containerVerification(input: VerificationInput): ContainerVerificationPlan {
  const image = `spec-local/${input.slug}:${input.fingerprint.slice(7, 19)}`
  const attestBuild = [
    "docker buildx build",
    "--sbom=true",
    "--provenance=mode=max",
    `--platform ${quote(input.platform)}`,
    `--file ${quote(input.dockerfilePath)}`,
    "--build-arg SPEC_SOURCE_REVISION",
    "--build-arg SPEC_TASK_ID",
    `--tag ${quote(image)}`,
    `--output ${quote(`type=oci,dest=${input.ociArchivePath}`)}`,
    ".",
  ].join(" ")
  const loadBuild = [
    "docker buildx build", "--load",
    `--platform ${quote(input.platform)}`,
    `--file ${quote(input.dockerfilePath)}`,
    "--build-arg SPEC_SOURCE_REVISION", "--build-arg SPEC_TASK_ID",
    `--tag ${quote(image)}`, ".",
  ].join(" ")
  return {
    requiredEnvironment: ["SPEC_SOURCE_REVISION", "SPEC_TASK_ID"],
    tests: {
      [input.configTestPath]: CONFIG_TEST,
      [input.runtimeTestPath]: RUNTIME_TEST,
      [input.attestationTestPath]: ATTESTATION_TEST,
    },
    setup: [
      { name: `attested-build:${input.slug}`, command: attestBuild, timeoutMs: 900_000 },
      { name: `runtime-build:${input.slug}`, command: loadBuild, timeoutMs: 900_000 },
    ],
    check: [
      {
        name: `attestations:${input.slug}`,
        command: `node ${quote(input.attestationTestPath)} ${quote(input.ociArchivePath)}`,
        timeoutMs: 60_000,
      },
      {
        name: `config:${input.slug}`,
        command: `node ${quote(input.configTestPath)} ${quote(input.contractPath)} ${quote(image)}`,
        timeoutMs: 60_000,
      },
      {
        name: `runtime:${input.slug}`,
        command: `node ${quote(input.runtimeTestPath)} ${quote(input.contractPath)} ${quote(image)}`,
        timeoutMs: 180_000,
      },
    ],
  }
}
