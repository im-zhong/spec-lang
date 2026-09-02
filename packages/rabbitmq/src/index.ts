import { nodeBuilder, serializeValue, type SpecNodeBuilder } from "@spec/core"

export interface RabbitMqInput { urlEnv?: string; prefetch?: number; heartbeatSeconds?: number }

export function rabbitmq(input: RabbitMqInput = {}): SpecNodeBuilder {
  return nodeBuilder("@spec/rabbitmq", "rabbitmq", undefined, {
    urlEnv: input.urlEnv ?? "RABBITMQ_URL",
    prefetch: serializeValue(input.prefetch ?? 16),
    heartbeatSeconds: serializeValue(input.heartbeatSeconds ?? 30),
    provides: ["MessageBroker", "RabbitMQBroker"],
  })
}

export { default as rabbitMqPackage } from "./spec-package"
