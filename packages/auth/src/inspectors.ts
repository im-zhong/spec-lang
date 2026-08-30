import type { NodeInspector, SpecNode } from "@spec/core"

function inspectAuth(node: SpecNode): { label: string; lines: string[] } {
  const principal = node.attributes.principal
  const principalLabel =
    principal && typeof principal === "object" && "nodeId" in (principal as Record<string, unknown>)
      ? String((principal as { nodeId: unknown }).nodeId).split(":").slice(1).join(":")
      : "<invalid>"
  return { label: node.name ?? "auth", lines: [`principal: ${principalLabel}`] }
}

function inspectPasswordStrategy(node: SpecNode): { label: string; lines: string[] } {
  const identity = node.attributes.identity as
    | { __fieldRef?: boolean; entity?: string; field?: string }
    | undefined
  const identityLabel =
    identity && identity.__fieldRef
      ? `${identity.entity}.${identity.field}`
      : "<invalid>"
  return { label: "password", lines: [`identity: ${identityLabel}`] }
}

export const authInspectors: Record<string, NodeInspector> = {
  auth: inspectAuth,
  passwordStrategy: inspectPasswordStrategy,
}
