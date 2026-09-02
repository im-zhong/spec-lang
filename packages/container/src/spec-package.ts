import type { Diagnostic, SpecNode } from "@spec/core"
import { defineNode, definePackage, defineValidator, diag, provides } from "@spec/package-sdk"
import { isSafeNonRootOciUser } from "./user"

const DIGEST_REFERENCE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/
const ALLOWED_PLATFORMS = new Set(["linux/amd64", "linux/arm64"])

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateImage(
  diagnostics: Diagnostic[],
  node: SpecNode,
  field: string,
): void {
  const value = node.attributes[field]
  if (typeof value !== "string" || !DIGEST_REFERENCE.test(value)) {
    diagnostics.push(diag(
      "CONTAINER_IMAGE_NOT_IMMUTABLE",
      "error",
      `${node.kind} ${field} must be an OCI image reference pinned with @sha256:<64 lowercase hex>.`,
      { nodeId: node.id, details: { field, value } },
    ))
  }
}

function validateStringArray(
  diagnostics: Diagnostic[],
  node: SpecNode,
  field: string,
  required: boolean,
): void {
  const value = node.attributes[field]
  if (
    (value === undefined && !required) ||
    (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0))
  ) return
  diagnostics.push(diag(
    "CONTAINER_EXEC_FORM_INVALID",
    "error",
    `${node.kind} ${field} must be a non-empty string array (OCI exec form).`,
    { nodeId: node.id, details: { field } },
  ))
}

function safeRelativePath(value: unknown): boolean {
  return typeof value === "string" && /^(?!\.\.?(?:\/|$))(?!.*\/\.\.?(?:\/|$))[^\\\x00]+$/.test(value)
}

export const validateContainers = defineValidator("container/validate", (ctx) => {
  const diagnostics: Diagnostic[] = []
  const nodes = [
    ...ctx.findNodes("container"),
    ...ctx.findNodes("backend-container"),
    ...ctx.findNodes("frontend-container"),
  ]
  const serviceOwners = new Map<string, string>()

  for (const node of nodes) {
    const service = node.attributes.service
    const serviceId = object(service) && typeof service.nodeId === "string" ? service.nodeId : undefined
    const target = serviceId ? ctx.getNode(serviceId) : undefined
    if (!serviceId || !target) {
      diagnostics.push(diag(
        "CONTAINER_SERVICE_INVALID",
        "error",
        `${node.kind} must reference an existing named service target.`,
        { nodeId: node.id, details: { service } },
      ))
    } else {
      const expectedKind = node.kind === "backend-container"
        ? "fastapi"
        : node.kind === "frontend-container" ? "react" : undefined
      if (expectedKind && target.kind !== expectedKind) {
        diagnostics.push(diag(
          "CONTAINER_SERVICE_KIND_INVALID",
          "error",
          `${node.kind} must reference a ${expectedKind} target; received ${target.kind}.`,
          { nodeId: node.id, details: { service: serviceId, expectedKind, actualKind: target.kind } },
        ))
      }
      const previous = serviceOwners.get(serviceId)
      if (previous) {
        diagnostics.push(diag(
          "CONTAINER_SERVICE_DUPLICATE",
          "error",
          `Service ${serviceId} is assigned to more than one container contract: ${previous}, ${node.id}.`,
          { nodeId: node.id, details: { service: serviceId, containers: [previous, node.id] } },
        ))
      } else {
        serviceOwners.set(serviceId, node.id)
      }
    }

    if (node.kind === "frontend-container") {
      validateImage(diagnostics, node, "buildImage")
      validateImage(diagnostics, node, "runtimeImage")
      validateStringArray(diagnostics, node, "installCommand", true)
      validateStringArray(diagnostics, node, "buildCommand", true)
      for (const field of ["packageManifest", "lockfile", "outputDirectory"]) {
        if (safeRelativePath(node.attributes[field])) continue
        diagnostics.push(diag(
          "CONTAINER_FRONTEND_PATH_INVALID",
          "error",
          `frontend-container ${field} must be a safe non-empty relative path.`,
          { nodeId: node.id, details: { field, value: node.attributes[field] } },
        ))
      }
      if (node.attributes.staticServer !== "nginx") {
        diagnostics.push(diag("CONTAINER_FRONTEND_SERVER_INVALID", "error", "frontend-container staticServer must be nginx.", { nodeId: node.id }))
      }
      if (typeof node.attributes.documentRoot !== "string" || !/^\/(?!.*\/\.\.?(?:\/|$))[\x20-\x7e]+$/.test(node.attributes.documentRoot)) {
        diagnostics.push(diag("CONTAINER_FRONTEND_DOCUMENT_ROOT_INVALID", "error", "frontend-container documentRoot must be a safe absolute container path.", { nodeId: node.id }))
      }
    } else {
      validateImage(diagnostics, node, "baseImage")
      validateStringArray(diagnostics, node, "command", node.kind === "backend-container")
      if (node.kind === "backend-container") validateStringArray(diagnostics, node, "installCommand", true)
    }

    if (!ALLOWED_PLATFORMS.has(String(node.attributes.platform))) {
      diagnostics.push(diag(
        "CONTAINER_PLATFORM_INVALID",
        "error",
        "container platform must be linux/amd64 or linux/arm64.",
        { nodeId: node.id, details: { platform: node.attributes.platform } },
      ))
    }
    const port = node.attributes.port
    if (port !== undefined && (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535)) {
      diagnostics.push(diag(
        "CONTAINER_PORT_INVALID",
        "error",
        "container port must be an integer from 1 to 65535.",
        { nodeId: node.id, details: { port } },
      ))
    }
    if (!isSafeNonRootOciUser(node.attributes.user)) {
      diagnostics.push(diag(
        "CONTAINER_ROOT_USER_FORBIDDEN",
        "error",
        "containers must declare a non-root runtime user.",
        { nodeId: node.id, details: { user: node.attributes.user } },
      ))
    }
    if (typeof node.attributes.workdir !== "string" || !node.attributes.workdir.startsWith("/")) {
      diagnostics.push(diag(
        "CONTAINER_WORKDIR_INVALID",
        "error",
        "container workdir must be an absolute path.",
        { nodeId: node.id, details: { workdir: node.attributes.workdir } },
      ))
    }
    const environment = node.attributes.environment
    if (!object(environment) || Object.entries(environment).some(([key, value]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string")) {
      diagnostics.push(diag(
        "CONTAINER_ENVIRONMENT_INVALID",
        "error",
        "container environment must map uppercase variable names to string values.",
        { nodeId: node.id },
      ))
    }
    const healthcheck = node.attributes.healthcheck
    if (healthcheck !== undefined) {
      if (!object(healthcheck)) {
        diagnostics.push(diag("CONTAINER_HEALTHCHECK_INVALID", "error", "container healthcheck must be an object.", { nodeId: node.id }))
      } else {
        const command = healthcheck.command
        const timingFields = ["intervalSeconds", "timeoutSeconds", "startPeriodSeconds"]
        const invalidTiming = timingFields.some((field) => healthcheck[field] !== undefined && (typeof healthcheck[field] !== "number" || Number(healthcheck[field]) <= 0))
        const invalidRetries = healthcheck.retries !== undefined && (!Number.isInteger(healthcheck.retries) || Number(healthcheck.retries) < 1)
        if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== "string" || item.length === 0) || invalidTiming || invalidRetries) {
          diagnostics.push(diag(
            "CONTAINER_HEALTHCHECK_INVALID",
            "error",
            "container healthcheck requires an exec-form command, positive timings, and positive integer retries.",
            { nodeId: node.id },
          ))
        }
      }
    }
  }

  return diagnostics
})

function inspect(node: SpecNode) {
  const service = object(node.attributes.service) ? String(node.attributes.service.nodeId ?? "?") : "?"
  const images = node.kind === "frontend-container"
    ? `${String(node.attributes.buildImage)} -> ${String(node.attributes.runtimeImage)}`
    : String(node.attributes.baseImage)
  return {
    label: node.name ?? node.kind,
    lines: [
      `profile: ${String(node.attributes.profile)}  service: ${service}`,
      `image: ${images}`,
      `platform: ${String(node.attributes.platform)}  user: ${String(node.attributes.user)}  port: ${String(node.attributes.port ?? "—")}`,
    ],
  }
}

export default definePackage({
  name: "@spec/container",
  version: "0.1.0",
  nodeKinds: [defineNode("container"), defineNode("backend-container"), defineNode("frontend-container")],
  capabilities: [provides("ContainerImage")],
  validators: [validateContainers],
  inspectors: {
    container: inspect,
    "backend-container": inspect,
    "frontend-container": inspect,
  },
})
