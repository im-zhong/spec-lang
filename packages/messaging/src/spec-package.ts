import type { Diagnostic, SpecNode } from "@spec/core"
import { defineGeneration, definePackage, defineValidator, defineNode, diag } from "@spec/package-sdk"

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const FIELD_TYPES = new Set(["string", "int", "boolean", "uuid", "datetime"])

export const validateMessaging = defineValidator("messaging/validate", (ctx) => {
  const diagnostics: Diagnostic[] = []
  for (const node of ctx.findNodes("message")) {
    if (!object(node.attributes.fields) || Object.keys(node.attributes.fields).length === 0) {
      diagnostics.push(diag("MESSAGE_FIELDS_INVALID", "error", `message "${node.name ?? node.id}" must declare at least one field.`, { nodeId: node.id }))
      continue
    }
    for (const [name, type] of Object.entries(node.attributes.fields)) {
      if (!FIELD_TYPES.has(String(type))) diagnostics.push(diag("MESSAGE_FIELD_TYPE_INVALID", "error", `message field "${name}" has unsupported type "${String(type)}".`, { nodeId: node.id, details: { field: name, type } }))
    }
  }
  for (const node of ctx.findNodes("queue")) {
    const provider = node.attributes.provider
    const target = object(provider) && typeof provider.nodeId === "string" ? ctx.getNode(provider.nodeId) : undefined
    const capabilities = target && Array.isArray(target.attributes.provides) ? target.attributes.provides : []
    if (!target || !capabilities.includes("MessageBroker")) diagnostics.push(diag("QUEUE_PROVIDER_INVALID", "error", `queue "${node.name ?? node.id}" must reference a provider of MessageBroker.`, { nodeId: node.id }))
    if (!Array.isArray(node.attributes.messages) || node.attributes.messages.length === 0) {
      diagnostics.push(diag("QUEUE_MESSAGES_INVALID", "error", `queue "${node.name ?? node.id}" must contain at least one message.`, { nodeId: node.id }))
    } else {
      for (const ref of node.attributes.messages) {
        const messageNode = object(ref) && typeof ref.nodeId === "string" ? ctx.getNode(ref.nodeId) : undefined
        if (!messageNode || messageNode.kind !== "message") diagnostics.push(diag("QUEUE_MESSAGE_INVALID", "error", `queue "${node.name ?? node.id}" contains a non-message reference.`, { nodeId: node.id }))
      }
    }
    if (!["at-least-once", "at-most-once"].includes(String(node.attributes.delivery))) diagnostics.push(diag("QUEUE_DELIVERY_INVALID", "error", "queue delivery must be at-least-once or at-most-once.", { nodeId: node.id }))
    if (!Number.isInteger(node.attributes.maxAttempts) || Number(node.attributes.maxAttempts) < 1) diagnostics.push(diag("QUEUE_MAX_ATTEMPTS_INVALID", "error", "queue maxAttempts must be a positive integer.", { nodeId: node.id }))
    if (typeof node.attributes.backoffSeconds !== "number" || Number(node.attributes.backoffSeconds) < 0) diagnostics.push(diag("QUEUE_BACKOFF_INVALID", "error", "queue backoffSeconds must be a non-negative number.", { nodeId: node.id }))
  }
  return diagnostics
})

function inspectQueue(node: SpecNode) {
  return { label: node.name ?? "queue", lines: [`delivery: ${String(node.attributes.delivery)}  attempts: ${String(node.attributes.maxAttempts)}`, `dead letter: ${String(node.attributes.deadLetter ?? "—")}`] }
}

export default definePackage({
  name: "@spec/messaging",
  version: "0.1.0",
  nodeKinds: [defineNode("message"), defineNode("queue")],
  validators: [validateMessaging],
  inspectors: { queue: inspectQueue },
  generation: [
    defineGeneration({
      id: "messaging-behavior",
      target: "fastapi-python",
      nodeKinds: ["message", "queue"],
      tasks: ["messaging", "app"],
      instructions: [
        "Validate every outgoing payload against the declared message schema before publishing.",
        "Use a stable message envelope containing message name, version, id, occurred_at, and payload.",
        "Implement retry, acknowledgement, idempotency, ordering, and dead-letter behavior exactly as declared by each queue.",
        "Provider failures must never be silently acknowledged; adapters must be injectable and testable without live brokers.",
      ],
    }),
  ],
})
