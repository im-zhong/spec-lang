import { isNodeBuilder, nodeBuilder, serializeValue, toReference, type SpecNodeBuilder } from "@spec/core"

export type MessageFieldType = "string" | "int" | "boolean" | "uuid" | "datetime"
export type DeliveryGuarantee = "at-least-once" | "at-most-once"

export interface MessageInput { fields: Record<string, MessageFieldType> }

export function message(name: string, input: MessageInput): SpecNodeBuilder {
  return nodeBuilder("@spec/messaging", "message", name, { fields: serializeValue(input?.fields) })
}

export interface QueueInput {
  provider: unknown
  messages: unknown[]
  delivery?: DeliveryGuarantee
  maxAttempts?: number
  backoffSeconds?: number
  deadLetter?: string
  orderingKey?: string
}

export function queue(name: string, input: QueueInput): SpecNodeBuilder {
  return nodeBuilder("@spec/messaging", "queue", name, {
    provider: isNodeBuilder(input?.provider) ? toReference(input.provider) : serializeValue(input?.provider),
    messages: Array.isArray(input?.messages)
      ? input.messages.map((item) => isNodeBuilder(item) ? toReference(item) : serializeValue(item))
      : serializeValue(input?.messages),
    delivery: input?.delivery ?? "at-least-once",
    maxAttempts: serializeValue(input?.maxAttempts ?? 3),
    backoffSeconds: serializeValue(input?.backoffSeconds ?? 1),
    ...(input?.deadLetter !== undefined ? { deadLetter: serializeValue(input.deadLetter) } : {}),
    ...(input?.orderingKey !== undefined ? { orderingKey: serializeValue(input.orderingKey) } : {}),
  })
}

export { default as messagingPackage } from "./spec-package"
