import type { Diagnostic, SpecNode } from "@spec/core"
import { defineGeneration, definePackage, defineValidator, defineNode, diag } from "@spec/package-sdk"

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }

export const validateBlob = defineValidator("blob/validate", (ctx) => {
  const diagnostics: Diagnostic[] = []
  for (const node of ctx.findNodes("blob")) {
    const provider = node.attributes.provider
    const target = object(provider) && typeof provider.nodeId === "string" ? ctx.getNode(provider.nodeId) : undefined
    const capabilities = target && Array.isArray(target.attributes.provides) ? target.attributes.provides : []
    if (!target || !capabilities.includes("BlobStore")) diagnostics.push(diag("BLOB_PROVIDER_INVALID", "error", `blob "${node.name ?? node.id}" must reference a provider of BlobStore.`, { nodeId: node.id }))
    if (typeof node.attributes.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(node.attributes.bucket)) diagnostics.push(diag("BLOB_BUCKET_INVALID", "error", "blob bucket must be a valid lowercase bucket name of 3-63 characters.", { nodeId: node.id }))
    if (!Number.isInteger(node.attributes.maxBytes) || Number(node.attributes.maxBytes) < 1) diagnostics.push(diag("BLOB_MAX_BYTES_INVALID", "error", "blob maxBytes must be a positive integer.", { nodeId: node.id }))
    if (!Array.isArray(node.attributes.contentTypes) || node.attributes.contentTypes.length === 0 || !node.attributes.contentTypes.every((type) => typeof type === "string" && type.includes("/"))) diagnostics.push(diag("BLOB_CONTENT_TYPES_INVALID", "error", "blob contentTypes must contain at least one MIME type.", { nodeId: node.id }))
    if (!Number.isInteger(node.attributes.signedUrlTtlSeconds) || Number(node.attributes.signedUrlTtlSeconds) < 1) diagnostics.push(diag("BLOB_SIGNED_URL_TTL_INVALID", "error", "blob signedUrlTtlSeconds must be a positive integer.", { nodeId: node.id }))
  }
  return diagnostics
})

function inspect(node: SpecNode) { return { label: node.name ?? "blob", lines: [`bucket: ${String(node.attributes.bucket)}  prefix: ${String(node.attributes.keyPrefix)}`, `limit: ${String(node.attributes.maxBytes)} bytes  URL TTL: ${String(node.attributes.signedUrlTtlSeconds)}s`] } }

export default definePackage({
  name: "@spec/blob", version: "0.1.0", nodeKinds: [defineNode("blob")], validators: [validateBlob], inspectors: { blob: inspect },
  generation: [defineGeneration({
    id: "blob-behavior", target: "fastapi-python", nodeKinds: ["blob"], tasks: ["blob", "app"],
    instructions: [
      "Reject objects exceeding maxBytes or outside the declared MIME allowlist before provider upload.",
      "Normalize object keys under the declared prefix and reject traversal, empty segments, and absolute keys.",
      "Generate signed URLs with exactly the declared TTL and never expose provider credentials.",
      "Inject the blob client and provide an in-memory implementation with identical validation semantics for conformance tests.",
    ],
  })],
})
