import { isNodeBuilder, nodeBuilder, serializeValue, toReference, type SpecNodeBuilder } from "@spec/core"

export type CacheFailureMode = "bypass" | "fail-closed"

export interface CacheInput {
  provider: unknown
  keyPrefix: string
  ttlSeconds: number
  failureMode?: CacheFailureMode
  stampedeProtection?: boolean
}

export function cache(input: CacheInput): SpecNodeBuilder {
  return nodeBuilder("@spec/cache", "cache", undefined, {
    provider: isNodeBuilder(input?.provider) ? toReference(input.provider) : serializeValue(input?.provider),
    keyPrefix: serializeValue(input?.keyPrefix),
    ttlSeconds: serializeValue(input?.ttlSeconds),
    failureMode: input?.failureMode ?? "bypass",
    stampedeProtection: input?.stampedeProtection === true,
  })
}

export { default as cachePackage } from "./spec-package"
