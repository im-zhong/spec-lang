import { nodeBuilder, serializeValue, type SpecNodeBuilder } from "@spec/core"

export const REDIS_PROVIDES = ["CacheStore", "KeyValueStore", "DistributedLock"]

export interface RedisInput {
  urlEnv?: string
  connectTimeoutSeconds?: number
  operationTimeoutSeconds?: number
}

export function redis(input: RedisInput = {}): SpecNodeBuilder {
  return nodeBuilder("@spec/redis", "redis", undefined, {
    urlEnv: input.urlEnv ?? "REDIS_URL",
    connectTimeoutSeconds: serializeValue(input.connectTimeoutSeconds ?? 2),
    operationTimeoutSeconds: serializeValue(input.operationTimeoutSeconds ?? 1),
    provides: [...REDIS_PROVIDES],
  })
}

export { default as redisPackage } from "./spec-package"
