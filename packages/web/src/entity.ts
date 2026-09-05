/**
 * Entity builder.
 *
 * `entity("User", { id: field.uuid(), ... })` returns a node builder whose
 * IR attributes contain plain field definitions, and which additionally
 * exposes a `.fields` map so specifications can reference fields:
 *
 *   auth({ strategy: password({ identity: User.fields.email }) })
 *
 * `.fields` is metadata for static evaluation only — it never serializes
 * into the IR.
 */
import {
  fieldRef,
  nodeId,
  nodeBuilder,
  type FieldRef,
  type SpecNodeBuilder,
} from "@spec/core"
import { isFieldSpec, type FieldSpec } from "./field"

export interface EntityBuilder extends SpecNodeBuilder {
  fields: Record<string, FieldRef>
}

export function entity(name: string, fieldsInput: Record<string, unknown>): EntityBuilder {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("entity: first argument must be a non-empty name string")
  }
  const attributes: Record<string, unknown> = { fields: {} }
  const fieldRefs: Record<string, FieldRef> = {}
  const ownerNodeId = nodeId("entity", name)
  const fieldsAttr = attributes.fields as Record<string, unknown>
  for (const fieldName of Object.keys(fieldsInput)) {
    const value = fieldsInput[fieldName]
    if (isFieldSpec(value)) {
      const plain: Record<string, unknown> = { type: value.type }
      if (value.uniqueFlag) plain.unique = true
      if (value.optionalFlag) plain.optional = true
      if (value.hasDefault) plain.default = value.defaultValue
      if (value.refTarget !== undefined) plain.target = value.refTarget
      if (value.states !== undefined) plain.states = [...value.states]
      if (value.minValue !== undefined) plain.min = value.minValue
      if (value.maxValue !== undefined) plain.max = value.maxValue
      if (value.maxLengthValue !== undefined) plain.maxLength = value.maxLengthValue
      fieldsAttr[fieldName] = plain
      fieldRefs[fieldName] = fieldRef(name, fieldName, ownerNodeId, value.uniqueFlag === true)
    } else {
      // Not produced by a field builder — pass through raw and let the
      // web validator report an INVALID_FIELD_DEFINITION diagnostic.
      fieldsAttr[fieldName] = value
    }
  }
  const builder = nodeBuilder("@spec/web", "entity", name, attributes)
  return Object.assign(builder, { fields: fieldRefs })
}

export function isEntityBuilder(value: unknown): value is EntityBuilder {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__specNodeBuilder === true &&
    (value as SpecNodeBuilder).kind === "entity"
  )
}
