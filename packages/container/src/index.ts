/**
 * @spec/container describes OCI image and runtime contracts. It deliberately
 * does not run Docker: builders produce deterministic data for a container
 * lowering/verifier to consume.
 */
import {
  isNodeBuilder,
  nodeBuilder,
  serializeValue,
  toReference,
  type SpecNodeBuilder,
} from "@spec/core"

export type OciPlatform = "linux/amd64" | "linux/arm64"

export interface HealthcheckInput {
  command: string[]
  intervalSeconds?: number
  timeoutSeconds?: number
  startPeriodSeconds?: number
  retries?: number
}

export interface ContainerRuntimeInput {
  platform?: OciPlatform
  workdir?: string
  user?: string
  port?: number
  command?: string[]
  environment?: Record<string, string>
  healthcheck?: HealthcheckInput
  readOnlyRootFilesystem?: boolean
  init?: boolean
  stopSignal?: "SIGTERM" | "SIGINT"
}

export interface ContainerInput extends ContainerRuntimeInput {
  service: unknown
  /** OCI reference pinned by digest: registry/repository@sha256:<64 hex>. */
  baseImage: string
  copy?: Array<{ from: string; to: string }>
}

export interface BackendContainerInput extends ContainerRuntimeInput {
  /** Must reference a backend target (currently fastapi). */
  service: unknown
  /** Runtime/build image pinned by digest. */
  baseImage: string
  installCommand?: string[]
}

export interface FrontendContainerInput extends Omit<ContainerRuntimeInput, "command"> {
  /** Must reference a frontend target (currently react). */
  service: unknown
  /** Build-stage image pinned by digest. */
  buildImage: string
  /** Static-file runtime image pinned by digest. */
  runtimeImage: string
  /** Lockfile-enforcing dependency installation (exec form). */
  installCommand?: string[]
  buildCommand?: string[]
  packageManifest?: string
  lockfile?: string
  outputDirectory?: string
  spaFallback?: boolean
  /** Stable static server profile. Currently only nginx is supported. */
  staticServer?: "nginx"
  documentRoot?: string
}

function serviceReference(service: unknown): unknown {
  return isNodeBuilder(service) ? toReference(service) : serializeValue(service)
}

function runtimeAttributes(input: ContainerRuntimeInput): Record<string, unknown> {
  return {
    platform: input.platform ?? "linux/amd64",
    workdir: input.workdir ?? "/app",
    user: input.user ?? "10001:10001",
    ...(input.port === undefined ? {} : { port: input.port }),
    ...(input.command === undefined ? {} : { command: serializeValue(input.command) }),
    environment: serializeValue(input.environment ?? {}),
    ...(input.healthcheck === undefined ? {} : { healthcheck: serializeValue(input.healthcheck) }),
    readOnlyRootFilesystem: input.readOnlyRootFilesystem ?? true,
    init: input.init ?? true,
    stopSignal: input.stopSignal ?? "SIGTERM",
  }
}

/** A technology-neutral, single-stage OCI image contract. */
export function container(name: string, input: ContainerInput): SpecNodeBuilder {
  return nodeBuilder("@spec/container", "container", name, {
    profile: "generic",
    service: serviceReference(input?.service),
    baseImage: input?.baseImage,
    copy: serializeValue(input?.copy ?? []),
    ...runtimeAttributes(input ?? ({} as ContainerInput)),
    provides: ["ContainerImage"],
  })
}

/** Opinionated Python/FastAPI image contract: non-root, exec-form startup. */
export function backendContainer(name: string, input: BackendContainerInput): SpecNodeBuilder {
  return nodeBuilder("@spec/container", "backend-container", name, {
    profile: "backend",
    service: serviceReference(input?.service),
    baseImage: input?.baseImage,
    installCommand: serializeValue(input?.installCommand ?? ["python", "-m", "pip", "install", "--no-cache-dir", "."]),
    ...runtimeAttributes({
      ...input,
      port: input?.port ?? 8000,
      command: input?.command ?? ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", String(input?.port ?? 8000)],
    }),
    provides: ["ContainerImage"],
  })
}

/** Opinionated multi-stage frontend image contract: build once, serve static output. */
export function frontendContainer(name: string, input: FrontendContainerInput): SpecNodeBuilder {
  return nodeBuilder("@spec/container", "frontend-container", name, {
    profile: "frontend",
    service: serviceReference(input?.service),
    buildImage: input?.buildImage,
    runtimeImage: input?.runtimeImage,
    installCommand: serializeValue(input?.installCommand ?? ["pnpm", "install", "--frozen-lockfile"]),
    buildCommand: serializeValue(input?.buildCommand ?? ["pnpm", "build"]),
    packageManifest: input?.packageManifest ?? "package.json",
    lockfile: input?.lockfile ?? "pnpm-lock.yaml",
    outputDirectory: input?.outputDirectory ?? "dist",
    spaFallback: input?.spaFallback ?? true,
    staticServer: input?.staticServer ?? "nginx",
    documentRoot: input?.documentRoot ?? "/usr/share/nginx/html",
    ...runtimeAttributes({
      ...input,
      workdir: input?.workdir ?? "/workspace",
      port: input?.port ?? 8080,
    }),
    provides: ["ContainerImage"],
  })
}

export { validateContainers } from "./spec-package"
export { isSafeNonRootOciUser } from "./user"
export { default as containerPackage } from "./spec-package"
export {
  DEFAULT_DOCKERIGNORE,
  lowerContainers,
  type ContainerContextManifest,
  type ContainerHealthcheckContract,
  type ContainerLoweringPlan,
  type ContainerProfile,
  type ContainerRuntimeContract,
  type LoweredContainer,
} from "./lowering"
export {
  containerVerification,
  type ContainerVerificationCommand,
  type ContainerVerificationPlan,
  type VerificationInput,
} from "./verify"
