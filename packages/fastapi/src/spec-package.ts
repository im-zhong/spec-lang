import { definePackage, defineNode, defineValidator, diag } from "@spec/package-sdk"
import type { Diagnostic, SpecNode } from "@spec/core"

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function flatten(nodes: SpecNode[]): SpecNode[] {
  const out: SpecNode[] = []
  const visit = (node: SpecNode) => {
    out.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  nodes.forEach(visit)
  return out
}

/**
 * FastAPI package semantics: every referenced service/resource must exist,
 * and served vocabulary must be backend-buildable.
 */
export const validateFastApi = defineValidator("fastapi/validate-server", (ctx) => {
  const diagnostics: Diagnostic[] = []
  const all = flatten([...ctx.nodes])
  const byId = new Map(all.map((n) => [n.id, n]))

  for (const server of ctx.findNodes("fastapi")) {
    const serviceKinds = new Set(["crud", "api", "auth", "lifecycle", "invariant"])
    const services = server.attributes.services
    if (!Array.isArray(services) || services.length === 0) {
      diagnostics.push(
        diag(
          "FASTAPI_NO_SERVICES",
          "warning",
          `FastAPI server "${server.name ?? server.id}" serves no services (nothing to expose).`,
          { nodeId: server.id },
        ),
      )
    } else {
      for (const ref of services) {
        if (!isPlainObject(ref) || typeof ref.nodeId !== "string") {
          diagnostics.push(
            diag(
              "FASTAPI_SERVICE_INVALID",
              "error",
              `FastAPI service entry must be a spec node (crud/api/auth); got ${JSON.stringify(ref)}.`,
              { nodeId: server.id },
            ),
          )
          continue
        }
        const target = byId.get(ref.nodeId)
        if (!target) {
          diagnostics.push(
            diag(
              "FASTAPI_SERVICE_NOT_FOUND",
              "error",
              `FastAPI server references "${ref.nodeId}" but no such node exists.`,
              { nodeId: server.id, details: { service: ref.nodeId } },
            ),
          )
          continue
        }
        if (!serviceKinds.has(target.kind)) {
          diagnostics.push(
            diag(
              "FASTAPI_SERVICE_KIND_UNSUPPORTED",
              "error",
              `FastAPI cannot serve "${target.id}" of kind "${target.kind}" (supported: crud, api, auth, lifecycle, invariant).`,
              { nodeId: server.id, details: { service: ref.nodeId, kind: target.kind } },
            ),
          )
        }
      }
    }

    const resources = server.attributes.resources
    if (Array.isArray(resources)) {
      for (const ref of resources) {
        if (!isPlainObject(ref) || typeof ref.nodeId !== "string") {
          diagnostics.push(
            diag(
              "FASTAPI_RESOURCE_INVALID",
              "error",
              `FastAPI resource entry must be a spec node; got ${JSON.stringify(ref)}.`,
              { nodeId: server.id },
            ),
          )
          continue
        }
        if (!byId.has(ref.nodeId)) {
          diagnostics.push(
            diag(
              "FASTAPI_RESOURCE_NOT_FOUND",
              "error",
              `FastAPI server references resource "${ref.nodeId}" but no such node exists.`,
              { nodeId: server.id, details: { resource: ref.nodeId } },
            ),
          )
        }
      }
    }

    // Generic api() nodes (no pinned operation) cannot be lowered.
    for (const ref of Array.isArray(services) ? services : []) {
      if (isPlainObject(ref) && byId.get(String(ref.nodeId))?.kind === "api") {
        const api = byId.get(String(ref.nodeId))!
        if (api.attributes.operation !== "count") {
          diagnostics.push(
            diag(
              "FASTAPI_API_OPERATION_UNSUPPORTED",
              "error",
              `api() node "${api.id}" has no pinned operation; only count(...) endpoints are supported by @spec/fastapi.`,
              { nodeId: api.id },
            ),
          )
        }
      }
    }
  }

  // The auth principal must not carry ref fields (its rows are created by
  // the register route; ref seeding there is not part of the contract).
  for (const authNode of ctx.findNodes("auth")) {
    const principalRef = authNode.attributes.principal
    if (!isPlainObject(principalRef) || typeof principalRef.nodeId !== "string") continue
    const principal = byId.get(principalRef.nodeId)
    if (!principal || principal.kind !== "entity") continue
    const fields = principal.attributes.fields
    if (isPlainObject(fields)) {
      for (const [fieldName, def] of Object.entries(fields)) {
        if (isPlainObject(def) && def.type === "ref") {
          diagnostics.push(
            diag(
              "FASTAPI_PRINCIPAL_REF_UNSUPPORTED",
              "error",
              `Auth principal "${principal.name}" must not have ref fields ("${fieldName}") — register cannot seed references.`,
              { nodeId: principal.id, details: { field: fieldName } },
            ),
          )
        }
      }
    }
  }

  // crud/auth nodes nobody serves are dead vocabulary (informational).
  const servers = ctx.findNodes("fastapi")
  if (servers.length > 0) {
    const served = new Set(
      servers.flatMap((s) =>
        (Array.isArray(s.attributes.services) ? s.attributes.services : [])
          .filter((r): r is { nodeId: string } => isPlainObject(r) && typeof r.nodeId === "string")
          .map((r) => r.nodeId),
      ),
    )
    for (const node of all) {
      if ((node.kind === "crud" || node.kind === "auth") && !served.has(node.id)) {
        diagnostics.push(
          diag(
            "FASTAPI_NODE_NOT_SERVED",
            "warning",
            `"${node.id}" is not served by any FastAPI server and will not appear in the generated backend.`,
            { nodeId: node.id },
          ),
        )
      }
    }
  }

  return diagnostics
})

function inspectFastApi(node: SpecNode): { label: string; lines: string[] } {
  const services = Array.isArray(node.attributes.services)
    ? (node.attributes.services as Array<{ nodeId?: string }>).map((s) => s.nodeId ?? "?")
    : []
  const resources = Array.isArray(node.attributes.resources)
    ? (node.attributes.resources as Array<{ nodeId?: string }>).map((s) => s.nodeId ?? "?")
    : []
  return {
    label: node.name ?? "fastapi",
    lines: [
      `title: ${String(node.attributes.title)}  prefix: ${String(node.attributes.prefix)}`,
      `services: ${services.join(", ") || "—"}`,
      `resources: ${resources.join(", ") || "—"}`,
    ],
  }
}

export default definePackage({
  name: "@spec/fastapi",
  version: "0.1.0",
  nodeKinds: [defineNode("fastapi")],
  validators: [validateFastApi],
  inspectors: { fastapi: inspectFastApi },
})
