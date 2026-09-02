import { nodeBuilder, serializeValue, type SpecNodeBuilder } from "@spec/core"

export interface KafkaInput { brokersEnv?: string; clientId?: string; requestTimeoutMs?: number }

export function kafka(input: KafkaInput = {}): SpecNodeBuilder {
  return nodeBuilder("@spec/kafka", "kafka", undefined, {
    brokersEnv: input.brokersEnv ?? "KAFKA_BROKERS",
    clientId: input.clientId ?? "spec-app",
    requestTimeoutMs: serializeValue(input.requestTimeoutMs ?? 5000),
    provides: ["MessageBroker", "KafkaBroker"],
  })
}

export { default as kafkaPackage } from "./spec-package"
