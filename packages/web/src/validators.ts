/**
 * Web package semantics (validation layer 4: package semantics).
 *
 * All web-specific rules live HERE, never in the compiler core.
 */
import type { Diagnostic, SpecNode } from "@spec/core"
import { defineValidator, diag } from "@spec/package-sdk"
import { FIELD_TYPES } from "./field"

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Duplicate entity names, duplicate field names, invalid field definitions. */
export const validateEntities = defineValidator("web/validate-entities", (ctx) => {
  const diagnostics: Diagnostic[] = []
  const entities = ctx.findNodes("entity")
  const seen = new Map<string, SpecNode>()

  for (const node of entities) {
    const name = node.name ?? ""
    const previous = seen.get(name)
    if (previous) {
      diagnostics.push(
        diag(
          "DUPLICATE_ENTITY_NAME",
          "error",
          `Duplicate entity name "${name}" (already defined at ${previous.source ? `${previous.source.file}:${previous.source.line}` : "unknown location"}).`,
          { nodeId: node.id, details: { entity: name, firstNode: previous.id } },
        ),
      )
    } else {
      seen.set(name, node)
    }
    diagnostics.push(...validateFields(node))
  }
  return diagnostics
})

function validateFields(node: SpecNode): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const fields = node.attributes.fields
  if (!isPlainObject(fields)) {
    diagnostics.push(
      diag(
        "INVALID_FIELD_DEFINITION",
        "error",
        `Entity "${node.name}" must define a fields object.`,
        { nodeId: node.id },
      ),
    )
    return diagnostics
  }
  const seenFields = new Set<string>()
  for (const fieldName of Object.keys(fields)) {
    if (seenFields.has(fieldName)) {
      diagnostics.push(
        diag("DUPLICATE_FIELD_NAME", "error", `Duplicate field name "${fieldName}".`, {
          nodeId: node.id,
          details: { entity: node.name, field: fieldName },
        }),
      )
      continue
    }
    seenFields.add(fieldName)
    const def = fields[fieldName]
    if (!isPlainObject(def) || typeof def.type !== "string") {
      diagnostics.push(
        diag(
          "INVALID_FIELD_DEFINITION",
          "error",
          `Field "${node.name}.${fieldName}" is not a valid field definition (use e.g. field.string()).`,
          { nodeId: node.id, details: { entity: node.name, field: fieldName } },
        ),
      )
      continue
    }
    if (!FIELD_TYPES.includes(def.type as never)) {
      diagnostics.push(
        diag(
          "FIELD_TYPE_UNKNOWN",
          "error",
          `Field "${node.name}.${fieldName}" has unknown type "${String(def.type)}". Supported: ${FIELD_TYPES.join(", ")}.`,
          { nodeId: node.id, details: { entity: node.name, field: fieldName, type: def.type } },
        ),
      )
    }
  }
  return diagnostics
}
