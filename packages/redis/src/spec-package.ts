import type { Diagnostic, SpecNode } from "@spec/core"
import { defineGeneration, definePackage, defineValidator, defineNode, diag, provides } from "@spec/package-sdk"

export const validateRedis = defineValidator("redis/validate", (ctx) => {
  const diagnostics: Diagnostic[] = []
  for (const node of ctx.findNodes("redis")) {
    if (typeof node.attributes.urlEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(node.attributes.urlEnv)) {
      diagnostics.push(diag("REDIS_URL_ENV_INVALID", "error", "redis urlEnv must be an uppercase environment variable name.", { nodeId: node.id }))
    }
    for (const field of ["connectTimeoutSeconds", "operationTimeoutSeconds"]) {
      const value = node.attributes[field]
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        diagnostics.push(diag("REDIS_TIMEOUT_INVALID", "error", `redis ${field} must be a positive number.`, { nodeId: node.id, details: { field } }))
      }
    }
  }
  return diagnostics
})

function inspect(node: SpecNode) {
  return { label: node.name ?? "redis", lines: [`url: env ${String(node.attributes.urlEnv)}`, `timeouts: connect ${String(node.attributes.connectTimeoutSeconds)}s / operation ${String(node.attributes.operationTimeoutSeconds)}s`] }
}

export default definePackage({
  name: "@spec/redis",
  version: "0.1.0",
  nodeKinds: [defineNode("redis")],
  capabilities: [provides("CacheStore"), provides("KeyValueStore"), provides("DistributedLock")],
  validators: [validateRedis],
  inspectors: { redis: inspect },
  generation: [
    defineGeneration({
      id: "redis-python",
      target: "fastapi-python",
      nodeKinds: ["redis"],
      tasks: ["project", "cache", "app"],
      dependencies: { redis: "8.1.0" },
      instructions: [
        "Use redis.asyncio with one application-scoped connection pool; never create a client per request.",
        "Apply the specified connect and operation timeouts and close the Redis client during FastAPI lifespan shutdown.",
        "Use atomic Redis operations for locks and compare-and-delete ownership when releasing them.",
        "Do not connect during module import; provider initialization must be lazy and independently replaceable by an in-memory test double.",
      ],
    }),
  ],
})
