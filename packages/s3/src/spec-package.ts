import type { Diagnostic, SpecNode } from "@spec/core"
import { defineGeneration, definePackage, defineValidator, defineNode, diag, provides } from "@spec/package-sdk"

function env(value: unknown): boolean { return typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value) }

export const validateS3 = defineValidator("s3/validate", (ctx) => {
  const diagnostics: Diagnostic[] = []
  for (const node of ctx.findNodes("s3")) {
    if (!env(node.attributes.regionEnv)) diagnostics.push(diag("S3_REGION_ENV_INVALID", "error", "s3 regionEnv must be an uppercase environment variable name.", { nodeId: node.id }))
    if (!env(node.attributes.endpointUrlEnv)) diagnostics.push(diag("S3_ENDPOINT_ENV_INVALID", "error", "s3 endpointUrlEnv must be an uppercase environment variable name.", { nodeId: node.id }))
    for (const field of ["connectTimeoutSeconds", "readTimeoutSeconds"]) {
      const value = node.attributes[field]
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) diagnostics.push(diag("S3_TIMEOUT_INVALID", "error", `s3 ${field} must be a positive number.`, { nodeId: node.id, details: { field } }))
    }
  }
  return diagnostics
})

function inspect(node: SpecNode) { return { label: node.name ?? "s3", lines: [`region: env ${String(node.attributes.regionEnv)}  endpoint: env ${String(node.attributes.endpointUrlEnv)}`] } }

export default definePackage({
  name: "@spec/s3", version: "0.1.0", nodeKinds: [defineNode("s3")], capabilities: [provides("BlobStore"), provides("S3BlobStore")], validators: [validateS3], inspectors: { s3: inspect },
  generation: [defineGeneration({
    id: "s3-python", target: "fastapi-python", nodeKinds: ["s3"], tasks: ["project", "blob", "app"], dependencies: { boto3: "1.43.85" },
    instructions: [
      "Create one configured boto3 S3 client during lifespan setup and run blocking calls with asyncio.to_thread.",
      "Use botocore Config for explicit connect/read timeouts, bounded retries, and path-style addressing when declared.",
      "Use multipart upload for large objects, abort failed multipart uploads, and generate presigned URLs only for normalized keys.",
    ],
  })],
})
