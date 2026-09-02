import type { Diagnostic, SpecNode } from "@spec/core"
import { defineGeneration, definePackage, defineValidator, defineNode, diag } from "@spec/package-sdk"

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const validateCache = defineValidator("cache/validate", (ctx) => {
  const diagnostics: Diagnostic[] = []
  for (const node of ctx.findNodes("cache")) {
    if (typeof node.attributes.keyPrefix !== "string" || node.attributes.keyPrefix.length === 0) {
      diagnostics.push(diag("CACHE_KEY_PREFIX_INVALID", "error", "cache keyPrefix must be a non-empty string.", { nodeId: node.id }))
    }
    if (!Number.isInteger(node.attributes.ttlSeconds) || Number(node.attributes.ttlSeconds) <= 0) {
      diagnostics.push(diag("CACHE_TTL_INVALID", "error", "cache ttlSeconds must be a positive integer.", { nodeId: node.id }))
    }
    if (!["bypass", "fail-closed"].includes(String(node.attributes.failureMode))) {
      diagnostics.push(diag("CACHE_FAILURE_MODE_INVALID", "error", "cache failureMode must be \"bypass\" or \"fail-closed\".", { nodeId: node.id }))
    }
    const provider = node.attributes.provider
    const target = object(provider) && typeof provider.nodeId === "string" ? ctx.getNode(provider.nodeId) : undefined
    const capabilities = target && Array.isArray(target.attributes.provides) ? target.attributes.provides : []
    if (!target || !capabilities.includes("CacheStore")) {
      diagnostics.push(diag("CACHE_PROVIDER_INVALID", "error", `cache "${node.name ?? node.id}" must reference a provider of CacheStore.`, { nodeId: node.id }))
    }
  }
  return diagnostics
})

function inspect(node: SpecNode) {
  return {
    label: node.name ?? "cache",
    lines: [
      `key prefix: ${String(node.attributes.keyPrefix)}`,
      `ttl: ${String(node.attributes.ttlSeconds)}s  failure: ${String(node.attributes.failureMode)}`,
    ],
  }
}

export default definePackage({
  name: "@spec/cache",
  version: "0.1.0",
  nodeKinds: [defineNode("cache")],
  validators: [validateCache],
  inspectors: { cache: inspect },
  generation: [
    defineGeneration({
      id: "cache-behavior",
      target: "fastapi-python",
      nodeKinds: ["cache"],
      tasks: ["cache", "app"],
      instructions: [
        "Implement the cache-aside contract exactly: deterministic namespaced keys, explicit TTL, and JSON serialization.",
        "A bypass cache treats provider failures as misses; a fail-closed cache propagates a typed cache-unavailable error.",
        "Inject the cache client and make cache behavior testable without a live provider.",
        "When stampede protection is enabled, use a bounded per-key lock and always release it in a finally block.",
      ],
    }),
  ],
})
