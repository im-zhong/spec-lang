import { nodeBuilder, serializeValue, type SpecNodeBuilder } from "@spec/core"

export interface S3Input { regionEnv?: string; endpointUrlEnv?: string; forcePathStyle?: boolean; connectTimeoutSeconds?: number; readTimeoutSeconds?: number }

export function s3(input: S3Input = {}): SpecNodeBuilder {
  return nodeBuilder("@spec/s3", "s3", undefined, {
    regionEnv: input.regionEnv ?? "AWS_REGION",
    endpointUrlEnv: input.endpointUrlEnv ?? "S3_ENDPOINT_URL",
    forcePathStyle: input.forcePathStyle === true,
    connectTimeoutSeconds: serializeValue(input.connectTimeoutSeconds ?? 2),
    readTimeoutSeconds: serializeValue(input.readTimeoutSeconds ?? 10),
    provides: ["BlobStore", "S3BlobStore"],
  })
}

export { default as s3Package } from "./spec-package"
