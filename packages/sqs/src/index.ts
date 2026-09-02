import { nodeBuilder, serializeValue, type SpecNodeBuilder } from "@spec/core"

export interface SqsInput { regionEnv?: string; endpointUrlEnv?: string; visibilityTimeoutSeconds?: number }

export function sqs(input: SqsInput = {}): SpecNodeBuilder {
  return nodeBuilder("@spec/sqs", "sqs", undefined, {
    regionEnv: input.regionEnv ?? "AWS_REGION",
    endpointUrlEnv: input.endpointUrlEnv ?? "SQS_ENDPOINT_URL",
    visibilityTimeoutSeconds: serializeValue(input.visibilityTimeoutSeconds ?? 30),
    provides: ["MessageBroker", "SQSBroker"],
  })
}

export { default as sqsPackage } from "./spec-package"
