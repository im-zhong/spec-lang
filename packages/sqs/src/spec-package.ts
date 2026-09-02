import type { Diagnostic, SpecNode } from "@spec/core"
import { defineGeneration, definePackage, defineValidator, defineNode, diag, provides } from "@spec/package-sdk"

function env(value: unknown): boolean { return typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value) }

export const validateSqs = defineValidator("sqs/validate", (ctx) => {
  const diagnostics: Diagnostic[] = []
  for (const node of ctx.findNodes("sqs")) {
    if (!env(node.attributes.regionEnv)) diagnostics.push(diag("SQS_REGION_ENV_INVALID", "error", "sqs regionEnv must be an uppercase environment variable name.", { nodeId: node.id }))
    if (!env(node.attributes.endpointUrlEnv)) diagnostics.push(diag("SQS_ENDPOINT_ENV_INVALID", "error", "sqs endpointUrlEnv must be an uppercase environment variable name.", { nodeId: node.id }))
    if (!Number.isInteger(node.attributes.visibilityTimeoutSeconds) || Number(node.attributes.visibilityTimeoutSeconds) < 1) diagnostics.push(diag("SQS_VISIBILITY_TIMEOUT_INVALID", "error", "sqs visibilityTimeoutSeconds must be a positive integer.", { nodeId: node.id }))
  }
  return diagnostics
})

function inspect(node: SpecNode) { return { label: node.name ?? "sqs", lines: [`region: env ${String(node.attributes.regionEnv)}  visibility: ${String(node.attributes.visibilityTimeoutSeconds)}s`] } }

export default definePackage({
  name: "@spec/sqs", version: "0.1.0", nodeKinds: [defineNode("sqs")],
  capabilities: [provides("MessageBroker"), provides("SQSBroker")], validators: [validateSqs], inspectors: { sqs: inspect },
  generation: [defineGeneration({
    id: "sqs-python", target: "fastapi-python", nodeKinds: ["sqs"], tasks: ["project", "messaging", "app"],
    dependencies: { boto3: "1.43.85" },
    instructions: [
      "Create the boto3 SQS client once during lifespan setup and invoke its blocking calls via asyncio.to_thread.",
      "Use explicit visibility timeouts, long polling, stable deduplication ids, and declared FIFO group ids when ordering is required.",
      "Delete messages only after successful handling; exhausted messages must be sent to the declared dead-letter queue.",
    ],
  })],
})
