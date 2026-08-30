/**
 * Auth package semantics:
 *   - principal must be a valid reference to an entity
 *   - password identity must belong to the principal entity
 *   - identity should be unique (warning, not error)
 */
import type { Diagnostic, Reference, SpecNode } from "@spec/core"
import { defineValidator, diag } from "@spec/package-sdk"

interface SerializedFieldRef {
  __fieldRef: true
  entity: string
  field: string
  owner: string
}

function isReference(v: unknown): v is Reference {
  return typeof v === "object" && v !== null && typeof (v as Reference).nodeId === "string"
}

function isSerializedFieldRef(v: unknown): v is SerializedFieldRef {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).__fieldRef === true
  )
}

export const validateAuth = defineValidator("auth/validate-auth", (ctx) => {
  const diagnostics: Diagnostic[] = []
  for (const node of ctx.findNodes("auth")) {
    diagnostics.push(...validateOneAuth(node, ctx))
  }
  return diagnostics
})

function validateOneAuth(
  node: SpecNode,
  ctx: { getNode(id: string): SpecNode | undefined },
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const principal = node.attributes.principal

  if (!isReference(principal)) {
    diagnostics.push(
      diag(
        "AUTH_PRINCIPAL_INVALID",
        "error",
        `Auth principal must be an entity (received ${describe(principal)}).`,
        { nodeId: node.id, details: { principal } },
      ),
    )
    return diagnostics
  }

  const principalNode = ctx.getNode(principal.nodeId)
  if (!principalNode || principalNode.kind !== "entity") {
    diagnostics.push(
      diag(
        "AUTH_PRINCIPAL_NOT_ENTITY",
        "error",
        `Auth principal "${principal.nodeId}" does not resolve to an entity.`,
        { nodeId: node.id, details: { principal: principal.nodeId } },
      ),
    )
    return diagnostics
  }

  const principalName = principalNode.name ?? ""

  const strategies = (node.children ?? []).filter((c) => c.kind === "passwordStrategy")
  if (strategies.length === 0 && node.attributes.strategy !== undefined) {
    diagnostics.push(
      diag(
        "AUTH_IDENTITY_INVALID",
        "error",
        `Auth strategy must be created with password({...}) (received ${describe(node.attributes.strategy)}).`,
        { nodeId: node.id },
      ),
    )
    return diagnostics
  }

  for (const strategy of strategies) {
    diagnostics.push(...validateStrategy(node, principalName, strategy, principalNode))
  }
  return diagnostics
}

function validateStrategy(
  authNode: SpecNode,
  principalName: string,
  strategy: SpecNode,
  principalNode: SpecNode,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const identity = strategy.attributes.identity
  const authLabel = authNode.name ?? authNode.id

  if (!isSerializedFieldRef(identity)) {
    diagnostics.push(
      diag(
        "AUTH_IDENTITY_INVALID",
        "error",
        `Password strategy of auth "${authLabel}" must define an identity field reference (e.g. User.fields.email).`,
        { nodeId: strategy.id, source: strategy.source, details: { identity } },
      ),
    )
    return diagnostics
  }

  if (identity.entity !== principalName) {
    diagnostics.push(
      diag(
        "AUTH_IDENTITY_NOT_IN_PRINCIPAL",
        "error",
        `Auth identity ${identity.entity}.${identity.field} does not belong to principal entity "${principalName}".`,
        {
          nodeId: strategy.id,
          source: strategy.source,
          details: { identity: `${identity.entity}.${identity.field}`, principal: principalName },
        },
      ),
    )
    return diagnostics
  }

  const fields = principalNode.attributes.fields
  const fieldDef =
    typeof fields === "object" && fields !== null
      ? (fields as Record<string, unknown>)[identity.field]
      : undefined
  if (typeof fieldDef !== "object" || fieldDef === null) {
    diagnostics.push(
      diag(
        "AUTH_IDENTITY_NOT_IN_PRINCIPAL",
        "error",
        `Auth identity field "${identity.field}" does not exist on principal entity "${principalName}".`,
        {
          nodeId: strategy.id,
          source: strategy.source,
          details: { identity: `${identity.entity}.${identity.field}`, principal: principalName },
        },
      ),
    )
    return diagnostics
  }

  if ((fieldDef as Record<string, unknown>).unique !== true) {
    diagnostics.push(
      diag(
        "AUTH_IDENTITY_NOT_UNIQUE",
        "warning",
        `Authentication identity ${identity.entity}.${identity.field} should be unique.`,
        {
          nodeId: strategy.id,
          source: strategy.source,
          details: { identity: `${identity.entity}.${identity.field}` },
        },
      ),
    )
  }

  return diagnostics
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing"
  if (value === null) return "null"
  if (typeof value === "string") return `the string "${value}"`
  return `a ${typeof value} value`
}
