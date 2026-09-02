import type { Diagnostic, SpecNode } from "@spec/core"
import { defineGeneration, definePackage, defineValidator, defineNode, diag, provides } from "@spec/package-sdk"

export const validateRabbitMq = defineValidator("rabbitmq/validate", (ctx) => {
  const diagnostics: Diagnostic[] = []
  for (const node of ctx.findNodes("rabbitmq")) {
    if (typeof node.attributes.urlEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(node.attributes.urlEnv)) diagnostics.push(diag("RABBITMQ_URL_ENV_INVALID", "error", "rabbitmq urlEnv must be an uppercase environment variable name.", { nodeId: node.id }))
    if (!Number.isInteger(node.attributes.prefetch) || Number(node.attributes.prefetch) < 1) diagnostics.push(diag("RABBITMQ_PREFETCH_INVALID", "error", "rabbitmq prefetch must be a positive integer.", { nodeId: node.id }))
    if (typeof node.attributes.heartbeatSeconds !== "number" || Number(node.attributes.heartbeatSeconds) <= 0) diagnostics.push(diag("RABBITMQ_HEARTBEAT_INVALID", "error", "rabbitmq heartbeatSeconds must be positive.", { nodeId: node.id }))
  }
  return diagnostics
})

function inspect(node: SpecNode) { return { label: node.name ?? "rabbitmq", lines: [`url: env ${String(node.attributes.urlEnv)}  prefetch: ${String(node.attributes.prefetch)}`] } }

export default definePackage({
  name: "@spec/rabbitmq",
  version: "0.1.0",
  nodeKinds: [defineNode("rabbitmq")],
  capabilities: [provides("MessageBroker"), provides("RabbitMQBroker")],
  validators: [validateRabbitMq],
  inspectors: { rabbitmq: inspect },
  generation: [defineGeneration({
    id: "rabbitmq-python", target: "fastapi-python", nodeKinds: ["rabbitmq"], tasks: ["project", "messaging", "app"],
    dependencies: { "aio-pika": "10.0.1" },
    instructions: [
      "Use aio-pika robust connections and channels, publisher confirms, durable queues, and explicit prefetch QoS.",
      "Acknowledge only after successful handling; reject terminal failures to the declared dead-letter route.",
      "Open connections during application lifespan and close channels and connections in reverse order during shutdown.",
    ],
  })],
})
