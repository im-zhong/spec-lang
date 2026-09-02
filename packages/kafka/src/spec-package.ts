import type { Diagnostic, SpecNode } from "@spec/core"
import { defineGeneration, definePackage, defineValidator, defineNode, diag, provides } from "@spec/package-sdk"

export const validateKafka = defineValidator("kafka/validate", (ctx) => {
  const diagnostics: Diagnostic[] = []
  for (const node of ctx.findNodes("kafka")) {
    if (typeof node.attributes.brokersEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(node.attributes.brokersEnv)) diagnostics.push(diag("KAFKA_BROKERS_ENV_INVALID", "error", "kafka brokersEnv must be an uppercase environment variable name.", { nodeId: node.id }))
    if (typeof node.attributes.clientId !== "string" || node.attributes.clientId.length === 0) diagnostics.push(diag("KAFKA_CLIENT_ID_INVALID", "error", "kafka clientId must be non-empty.", { nodeId: node.id }))
    if (!Number.isInteger(node.attributes.requestTimeoutMs) || Number(node.attributes.requestTimeoutMs) < 1) diagnostics.push(diag("KAFKA_TIMEOUT_INVALID", "error", "kafka requestTimeoutMs must be a positive integer.", { nodeId: node.id }))
  }
  return diagnostics
})

function inspect(node: SpecNode) { return { label: node.name ?? "kafka", lines: [`brokers: env ${String(node.attributes.brokersEnv)}  client: ${String(node.attributes.clientId)}`] } }

export default definePackage({
  name: "@spec/kafka", version: "0.1.0", nodeKinds: [defineNode("kafka")],
  capabilities: [provides("MessageBroker"), provides("KafkaBroker")], validators: [validateKafka], inspectors: { kafka: inspect },
  generation: [defineGeneration({
    id: "kafka-python", target: "fastapi-python", nodeKinds: ["kafka"], tasks: ["project", "messaging", "app"],
    dependencies: { aiokafka: "0.14.0" },
    instructions: [
      "Use one lifespan-managed AIOKafkaProducer with idempotence enabled and deterministic JSON byte serialization.",
      "Use message ids as deduplication keys and the declared ordering field as the Kafka record key.",
      "Consumers must disable auto-commit and commit only after successful handling or terminal dead-letter publication.",
    ],
  })],
})
