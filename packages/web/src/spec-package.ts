import { definePackage, defineNode } from "@spec/package-sdk"
import {
  validateCountApis,
  validateCrud,
  validateEntities,
  validateInvariants,
  validateLifecycles,
} from "./validators"
import type { SpecNode } from "@spec/core"

function inspectEntity(node: SpecNode): { label: string; lines: string[] } {
  const fields = node.attributes.fields
  const lines: string[] = []
  if (fields && typeof fields === "object") {
    for (const [fieldName, def] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof def !== "object" || def === null) {
        lines.push(`${fieldName}: <invalid>`)
        continue
      }
      const d = def as Record<string, unknown>
      const flags = [
        d.unique === true ? "unique" : undefined,
        d.optional === true ? "optional" : undefined,
        d.default !== undefined ? `default ${JSON.stringify(d.default)}` : undefined,
        typeof d.target === "string" ? `→ ${d.target}` : undefined,
      ].filter(Boolean)
      lines.push(`${fieldName}: ${String(d.type)}${flags.length > 0 ? ` [${flags.join("][")}]` : ""}`)
    }
  }
  return { label: node.name ?? "entity", lines }
}

function inspectCrud(node: SpecNode): { label: string; lines: string[] } {
  const entity = node.attributes.entity as { nodeId?: string } | undefined
  const methods = Array.isArray(node.attributes.methods)
    ? (node.attributes.methods as string[]).join(", ")
    : "list, get, create, update, delete"
  const auth = node.attributes.auth === false ? "public" : "protected"
  return {
    label: `${node.name ?? "crud"} → ${entity?.nodeId ?? "<invalid>"}`,
    lines: [`${String(node.attributes.path)}  (${methods})  [${auth}]`],
  }
}

export default definePackage({
  name: "@spec/web",
  version: "0.1.0",
  nodeKinds: [
    defineNode("entity"),
    defineNode("field"),
    defineNode("page"),
    defineNode("api"),
    defineNode("crud"),
    defineNode("lifecycle"),
    defineNode("invariant"),
  ],
  validators: [validateEntities, validateCrud, validateCountApis, validateLifecycles, validateInvariants],
  inspectors: { entity: inspectEntity, crud: inspectCrud },
})
