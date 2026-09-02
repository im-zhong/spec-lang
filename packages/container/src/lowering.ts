import { createHash } from "node:crypto"
import { stableStringify, type SpecIR, type SpecNode } from "@spec/core"
import { containerVerification, type ContainerVerificationPlan } from "./verify"

export type ContainerProfile = "generic" | "backend" | "frontend"

export interface ContainerHealthcheckContract {
  command: string[]
  intervalSeconds: number
  timeoutSeconds: number
  startPeriodSeconds: number
  retries: number
  acceptanceTimeoutMs: number
}

export interface ContainerRuntimeContract {
  version: "spec-container-runtime/0.1"
  fingerprint: string
  nodeId: string
  serviceNodeId: string
  profile: ContainerProfile
  platform: "linux/amd64" | "linux/arm64"
  workdir: string
  user: string
  port?: number
  command?: string[]
  environment: Record<string, string>
  healthcheck?: ContainerHealthcheckContract
  readOnlyRootFilesystem: boolean
  init: boolean
  stopSignal: "SIGTERM" | "SIGINT"
  frontend?: {
    outputDirectory: string
    spaFallback: boolean
    staticServer: "nginx"
    documentRoot: string
  }
  labels: {
    static: Record<string, string>
    requiredNonEmpty: string[]
  }
  attestations: { sbom: true; provenance: true }
}

export interface ContainerContextManifest {
  version: "spec-container-context/0.1"
  context: "."
  dockerfile: string
  dockerignore: string
  sourceNodes: string[]
  /** Semantic hashes exclude source locations and other incidental metadata. */
  sourceNodeFingerprints: Record<string, string>
  serviceNodeId: string
  requiredBuildArguments: string[]
}

export interface LoweredContainer {
  nodeId: string
  profile: ContainerProfile
  slug: string
  fingerprint: string
  dockerfilePath: string
  dockerignorePath: string
  contextManifestPath: string
  runtimeContractPath: string
  files: Record<string, string>
  runtime: ContainerRuntimeContract
  verification: ContainerVerificationPlan
}

export interface ContainerLoweringPlan {
  version: "spec-container-plan/0.1"
  containers: LoweredContainer[]
  /** All outputs flattened by path; conflicting content is rejected. */
  files: Record<string, string>
  fingerprint: string
  stable: string
}

const NODE_KINDS = new Set(["container", "backend-container", "frontend-container"])
const DOCKERIGNORE = [
  ".git",
  ".github",
  ".devcontainer",
  ".DS_Store",
  ".env",
  ".env.*",
  ".spec/*",
  "!.spec/container",
  "!.spec/container/**",
  "**/__pycache__",
  "**/.pytest_cache",
  "**/.venv",
  "**/coverage",
  "**/dist",
  "**/node_modules",
  "*.log",
  "conformance",
  "conformance-output",
].join("\n") + "\n"

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex")}`
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`)
  return value
}

function immutableImage(value: unknown, field: string): string {
  const image = string(value, field)
  if (!/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image)) throw new Error(`${field} must be pinned by sha256 digest`)
  return image
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${field} must be a non-empty string array`)
  }
  return [...value] as string[]
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`)
  return value
}

function profile(node: SpecNode): ContainerProfile {
  if (node.kind === "backend-container") return "backend"
  if (node.kind === "frontend-container") return "frontend"
  return "generic"
}

function slug(node: SpecNode): string {
  const readable = (node.name ?? node.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "container"
  return `${readable.slice(0, 40)}-${hash(node.id).slice(7, 19)}`
}

function dockerString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/\$/g, "\\$").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`
}

function seconds(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`)
  return value
}

function healthcheck(node: SpecNode): ContainerHealthcheckContract | undefined {
  if (node.attributes.healthcheck === undefined) return undefined
  const input = record(node.attributes.healthcheck, `${node.id}.healthcheck`)
  const command = strings(input.command, `${node.id}.healthcheck.command`)
  if (command[0] !== "CMD") throw new Error(`${node.id}.healthcheck.command must start with CMD`)
  const intervalSeconds = seconds(input.intervalSeconds, 30, `${node.id}.healthcheck.intervalSeconds`)
  const timeoutSeconds = seconds(input.timeoutSeconds, 30, `${node.id}.healthcheck.timeoutSeconds`)
  const startPeriodSeconds = seconds(input.startPeriodSeconds, 0, `${node.id}.healthcheck.startPeriodSeconds`)
  const retries = seconds(input.retries, 3, `${node.id}.healthcheck.retries`)
  if (!Number.isInteger(retries)) throw new Error(`${node.id}.healthcheck.retries must be an integer`)
  return {
    command,
    intervalSeconds,
    timeoutSeconds,
    startPeriodSeconds,
    retries,
    acceptanceTimeoutMs: Math.ceil((startPeriodSeconds + intervalSeconds * retries + timeoutSeconds) * 1_000),
  }
}

function environment(node: SpecNode): Record<string, string> {
  const input = record(node.attributes.environment, `${node.id}.environment`)
  const result: Record<string, string> = {}
  for (const key of Object.keys(input).sort()) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`${node.id}.environment contains invalid key ${key}`)
    result[key] = string(input[key], `${node.id}.environment.${key}`)
  }
  return result
}

function runtimeWithoutFingerprint(node: SpecNode) {
  const service = record(node.attributes.service, `${node.id}.service`)
  const currentProfile = profile(node)
  const port = node.attributes.port
  if (port !== undefined && (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error(`${node.id}.port is invalid`)
  const command = node.kind === "frontend-container"
    ? ["nginx", "-g", "daemon off;", "-c", "/etc/nginx/nginx.conf"]
    : node.attributes.command === undefined ? undefined : strings(node.attributes.command, `${node.id}.command`)
  const result = {
    version: "spec-container-runtime/0.1" as const,
    nodeId: node.id,
    serviceNodeId: string(service.nodeId, `${node.id}.service.nodeId`),
    profile: currentProfile,
    platform: string(node.attributes.platform, `${node.id}.platform`) as "linux/amd64" | "linux/arm64",
    workdir: string(node.attributes.workdir, `${node.id}.workdir`),
    user: string(node.attributes.user, `${node.id}.user`),
    ...(port === undefined ? {} : { port: Number(port) }),
    ...(command === undefined ? {} : { command }),
    environment: environment(node),
    ...(node.attributes.healthcheck === undefined ? {} : { healthcheck: healthcheck(node) }),
    readOnlyRootFilesystem: bool(node.attributes.readOnlyRootFilesystem, `${node.id}.readOnlyRootFilesystem`),
    init: bool(node.attributes.init, `${node.id}.init`),
    stopSignal: string(node.attributes.stopSignal, `${node.id}.stopSignal`) as "SIGTERM" | "SIGINT",
    ...(currentProfile === "frontend" ? {
      frontend: {
        outputDirectory: string(node.attributes.outputDirectory, `${node.id}.outputDirectory`),
        spaFallback: bool(node.attributes.spaFallback, `${node.id}.spaFallback`),
        staticServer: string(node.attributes.staticServer, `${node.id}.staticServer`) as "nginx",
        documentRoot: string(node.attributes.documentRoot, `${node.id}.documentRoot`),
      },
    } : {}),
    labels: {
      static: {
        "io.spec.node-id": node.id,
        "io.spec.profile": currentProfile,
        "io.spec.service-node-id": string(service.nodeId, `${node.id}.service.nodeId`),
      },
      requiredNonEmpty: ["io.spec.source-revision", "io.spec.task-id"],
    },
    attestations: { sbom: true as const, provenance: true as const },
  }
  if (!new Set(["linux/amd64", "linux/arm64"]).has(result.platform)) throw new Error(`${node.id}.platform is unsupported`)
  if (!new Set(["SIGTERM", "SIGINT"]).has(result.stopSignal)) throw new Error(`${node.id}.stopSignal is unsupported`)
  if (!/^\/[\x20-\x7e]*$/.test(result.workdir)) throw new Error(`${node.id}.workdir must be a printable absolute path`)
  const [user, group] = result.user.split(":")
  if (user.toLowerCase() === "root" || user === "0" || group?.toLowerCase() === "root" || group === "0" ||
      !/^[A-Za-z_][A-Za-z0-9_.-]*$|^[1-9][0-9]*$/.test(user) ||
      (group !== undefined && !/^[A-Za-z_][A-Za-z0-9_.-]*$|^[1-9][0-9]*$/.test(group))) {
    throw new Error(`${node.id}.user is not a safe non-root OCI user`)
  }
  return result
}

function labelLines(runtime: Omit<ContainerRuntimeContract, "fingerprint">): string[] {
  return [
    "ARG SPEC_SOURCE_REVISION",
    "ARG SPEC_TASK_ID",
    `LABEL io.spec.node-id=${dockerString(runtime.nodeId)} \\
      io.spec.profile=${dockerString(runtime.profile)} \\
      io.spec.service-node-id=${dockerString(runtime.serviceNodeId)} \\
      io.spec.source-revision=\"\${SPEC_SOURCE_REVISION}\" \\
      io.spec.task-id=\"\${SPEC_TASK_ID}\"`,
  ]
}

function commonRuntimeLines(runtime: Omit<ContainerRuntimeContract, "fingerprint">): string[] {
  const lines = [`WORKDIR ${dockerString(runtime.workdir)}`]
  for (const [key, value] of Object.entries(runtime.environment)) lines.push(`ENV ${key}=${dockerString(value)}`)
  if (runtime.port) lines.push(`EXPOSE ${runtime.port}/tcp`)
  if (runtime.healthcheck) {
    const h = runtime.healthcheck
    lines.push(`HEALTHCHECK --interval=${h.intervalSeconds}s --timeout=${h.timeoutSeconds}s --start-period=${h.startPeriodSeconds}s --retries=${h.retries} CMD ${JSON.stringify(h.command.slice(1))}`)
  }
  lines.push(`USER ${runtime.user}`, `STOPSIGNAL ${runtime.stopSignal}`)
  if (runtime.command) lines.push(`CMD ${JSON.stringify(runtime.command)}`)
  return lines
}

function dockerfile(node: SpecNode, runtime: Omit<ContainerRuntimeContract, "fingerprint">): string {
  const lines = ["# syntax=docker/dockerfile:1.7"]
  if (runtime.profile === "frontend") {
    const buildImage = immutableImage(node.attributes.buildImage, `${node.id}.buildImage`)
    const runtimeImage = immutableImage(node.attributes.runtimeImage, `${node.id}.runtimeImage`)
    const installCommand = strings(node.attributes.installCommand, `${node.id}.installCommand`)
    const buildCommand = strings(node.attributes.buildCommand, `${node.id}.buildCommand`)
    const packageManifest = string(node.attributes.packageManifest, `${node.id}.packageManifest`)
    const lockfile = string(node.attributes.lockfile, `${node.id}.lockfile`)
    const nginxConfig = `.spec/container/${slug(node)}/nginx.conf`
    lines.push(
      `FROM --platform=${runtime.platform} ${buildImage} AS build`,
      `WORKDIR ${dockerString(runtime.workdir)}`,
      `COPY ${JSON.stringify([packageManifest, lockfile, "./"])}`,
      `RUN ${JSON.stringify(installCommand)}`,
      'COPY [".", "."]',
      `RUN ${JSON.stringify(buildCommand)}`,
      `FROM --platform=${runtime.platform} ${runtimeImage} AS runtime`,
      ...labelLines(runtime),
      `COPY --chown=${runtime.user} ${dockerString(nginxConfig)} ${dockerString("/etc/nginx/nginx.conf")}`,
      `COPY --from=build --chown=${runtime.user} ${dockerString(`${runtime.workdir}/${runtime.frontend?.outputDirectory}/`)} ${dockerString(`${runtime.frontend?.documentRoot}/`)}`,
      ...commonRuntimeLines(runtime),
    )
  } else {
    lines.push(`FROM --platform=${runtime.platform} ${immutableImage(node.attributes.baseImage, `${node.id}.baseImage`)} AS runtime`, ...labelLines(runtime), `WORKDIR ${dockerString(runtime.workdir)}`)
    if (runtime.profile === "backend") {
      lines.push(`COPY --chown=${runtime.user} [".", "."]`, `RUN ${JSON.stringify(strings(node.attributes.installCommand, `${node.id}.installCommand`))}`)
    } else {
      const copies = node.attributes.copy
      if (!Array.isArray(copies)) throw new Error(`${node.id}.copy must be an array`)
      for (const [index, value] of copies.entries()) {
        const copy = record(value, `${node.id}.copy[${index}]`)
        lines.push(`COPY --chown=${runtime.user} ${JSON.stringify([string(copy.from, `${node.id}.copy[${index}].from`), string(copy.to, `${node.id}.copy[${index}].to`)])}`)
      }
    }
    lines.push(...commonRuntimeLines(runtime).slice(1))
  }
  return lines.join("\n") + "\n"
}

function nginxConfig(runtime: Omit<ContainerRuntimeContract, "fingerprint">): string {
  const frontend = runtime.frontend
  if (!frontend || !runtime.port) throw new Error(`${runtime.nodeId} frontend runtime requires documentRoot and port`)
  const fallback = frontend.spaFallback ? "$uri $uri/ /index.html" : "$uri $uri/ =404"
  return `pid /tmp/nginx.pid;
error_log /dev/stderr notice;
events {}
http {
  access_log /dev/stdout;
  client_body_temp_path /tmp/client_temp;
  proxy_temp_path /tmp/proxy_temp;
  fastcgi_temp_path /tmp/fastcgi_temp;
  uwsgi_temp_path /tmp/uwsgi_temp;
  scgi_temp_path /tmp/scgi_temp;
  server {
    listen ${runtime.port};
    root ${frontend.documentRoot};
    index index.html;
    location / { try_files ${fallback}; }
  }
}
`
}

function lower(node: SpecNode, sourceNodes: SpecNode[]): LoweredContainer {
  const name = slug(node)
  const directory = `.spec/container/${name}`
  const dockerfilePath = `${directory}/Dockerfile`
  const dockerignorePath = ".dockerignore"
  const contextManifestPath = `${directory}/context-manifest.json`
  const runtimeContractPath = `${directory}/runtime-contract.json`
  const configTestPath = `${directory}/verify-config.mjs`
  const runtimeTestPath = `${directory}/verify-runtime.mjs`
  const attestationTestPath = `${directory}/verify-attestations.mjs`
  const ociArchivePath = `${directory}/image.oci.tar`
  const baseRuntime = runtimeWithoutFingerprint(node)
  const source = dockerfile(node, baseRuntime)
  const manifest: ContainerContextManifest = {
    version: "spec-container-context/0.1",
    context: ".",
    dockerfile: dockerfilePath,
    dockerignore: dockerignorePath,
    sourceNodes: sourceNodes.map((sourceNode) => sourceNode.id),
    sourceNodeFingerprints: Object.fromEntries(sourceNodes.map((sourceNode) => [
      sourceNode.id,
      hash({
        id: sourceNode.id,
        kind: sourceNode.kind,
        package: sourceNode.package,
        name: sourceNode.name,
        attributes: sourceNode.attributes,
        children: sourceNode.children,
      }),
    ])),
    serviceNodeId: baseRuntime.serviceNodeId,
    requiredBuildArguments: ["SPEC_SOURCE_REVISION", "SPEC_TASK_ID"],
  }
  const fingerprint = hash({ dockerfile: source, dockerignore: DOCKERIGNORE, manifest, runtime: baseRuntime })
  const runtime: ContainerRuntimeContract = { ...baseRuntime, fingerprint }
  const verification = containerVerification({
    slug: name,
    fingerprint,
    dockerfilePath,
    contractPath: runtimeContractPath,
    platform: runtime.platform,
    configTestPath,
    runtimeTestPath,
    attestationTestPath,
    ociArchivePath,
  })
  const files = {
    [dockerignorePath]: DOCKERIGNORE,
    [dockerfilePath]: source,
    [contextManifestPath]: stableStringify(manifest) + "\n",
    [runtimeContractPath]: stableStringify(runtime) + "\n",
    ...(runtime.profile === "frontend" ? { [`${directory}/nginx.conf`]: nginxConfig(baseRuntime) } : {}),
    ...verification.tests,
  }
  return { nodeId: node.id, profile: runtime.profile, slug: name, fingerprint, dockerfilePath, dockerignorePath, contextManifestPath, runtimeContractPath, files, runtime, verification }
}

/** Pure SpecIR -> OCI artifacts lowering. Input ordering cannot affect output. */
export function lowerContainers(ir: SpecIR): ContainerLoweringPlan {
  const nodesById = new Map(ir.nodes.map((node) => [node.id, node]))
  const dependencies = (containerNode: SpecNode): SpecNode[] => {
    const found = new Set<string>([containerNode.id])
    const pending: unknown[] = [containerNode.attributes.service]
    while (pending.length > 0) {
      const value = pending.pop()
      if (Array.isArray(value)) {
        pending.push(...value)
      } else if (typeof value === "object" && value !== null) {
        const input = value as Record<string, unknown>
        if (typeof input.nodeId === "string" && !found.has(input.nodeId)) {
          const target = nodesById.get(input.nodeId)
          if (!target) throw new Error(`${containerNode.id} references missing node ${input.nodeId}`)
          found.add(target.id)
          pending.push(target.attributes, target.children ?? [])
        } else {
          pending.push(...Object.values(input))
        }
      }
    }
    return [...found].sort().map((id) => nodesById.get(id) ?? containerNode)
  }
  const containers = ir.nodes
    .filter((node) => NODE_KINDS.has(node.kind))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => lower(node, dependencies(node)))
  const files: Record<string, string> = {}
  for (const container of containers) {
    for (const path of Object.keys(container.files).sort()) {
      const content = container.files[path]
      if (files[path] !== undefined && files[path] !== content) throw new Error(`container outputs conflict at ${path}`)
      files[path] = content
    }
  }
  const deterministic = {
    version: "spec-container-plan/0.1" as const,
    containers: containers.map(({ files: _files, ...container }) => container),
    files,
  }
  const stable = stableStringify(deterministic)
  return { ...deterministic, containers, fingerprint: hash(stable), stable }
}

export { DOCKERIGNORE as DEFAULT_DOCKERIGNORE }
