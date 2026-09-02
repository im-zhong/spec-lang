import { isNodeBuilder, nodeBuilder, serializeValue, toReference, type SpecNodeBuilder } from "@spec/core"

export interface BlobInput {
  provider: unknown
  bucket: string
  keyPrefix?: string
  maxBytes: number
  contentTypes: string[]
  signedUrlTtlSeconds?: number
  retentionDays?: number
}

export function blob(name: string, input: BlobInput): SpecNodeBuilder {
  return nodeBuilder("@spec/blob", "blob", name, {
    provider: isNodeBuilder(input?.provider) ? toReference(input.provider) : serializeValue(input?.provider),
    bucket: serializeValue(input?.bucket),
    keyPrefix: input?.keyPrefix ?? "",
    maxBytes: serializeValue(input?.maxBytes),
    contentTypes: serializeValue(input?.contentTypes),
    signedUrlTtlSeconds: serializeValue(input?.signedUrlTtlSeconds ?? 900),
    ...(input?.retentionDays !== undefined ? { retentionDays: serializeValue(input.retentionDays) } : {}),
  })
}

export { default as blobPackage } from "./spec-package"
