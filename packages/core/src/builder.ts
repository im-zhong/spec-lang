/**
 * Internal builder protocol.
 *
 * DSL functions in trusted specification packages (e.g. `entity()` in
 * `@spec/web`) return builder objects. The compiler statically evaluates
 * a `.spec.ts` file: it never executes user code, it only invokes trusted
 * package builders with statically-derived arguments.
 *
 * Builders are plain data plus markers, so they serialize deterministically.
 */
import type { SpecNode, SourceLocation, Constraint, Reference } from "./types"

const NODE_MARKER = "__specNodeBuilder"

export interface SpecNodeBuilder {
  readonly __specNodeBuilder: true
  kind: string
  package: string
  name?: string
  attributes: Record<string, unknown>
  children?: SpecNodeBuilder[]
  source?: SourceLocation
}

export function isNodeBuilder(value: unknown): value is SpecNodeBuilder {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__specNodeBuilder === true
  )
}

/** Deterministic node id scheme used across the whole system. */
export function nodeId(kind: string, name: string): string {
  return `${kind}:${name}`
}

/**
 * Create a node builder. Domain packages use this to fabricate the nodes
 * their DSL functions produce.
 */
export function nodeBuilder(
  pkg: string,
  kind: string,
  name: string | undefined,
  attributes: Record<string, unknown> = {},
  children: SpecNodeBuilder[] = [],
): SpecNodeBuilder {
  return {
    __specNodeBuilder: true,
    kind,
    package: pkg,
    ...(name === undefined ? {} : { name }),
    attributes,
    children,
  }
}

/**
 * Convert a node builder (or node id) into a serializable Reference.
 * The referenced node must be named — references to anonymous nodes are
 * not stable and therefore not supported.
 */
export function toReference(value: SpecNodeBuilder | string): Reference {
  if (typeof value === "string") return { nodeId: value }
  if (!value.name) {
    throw new Error(
      `Cannot create a reference to an anonymous ${value.kind} node in ${value.package}`,
    )
  }
  return { nodeId: nodeId(value.kind, value.name) }
}

/**
 * Marker for field-reference values produced by property access such as
 * `User.fields.email`. Field references are resolved by package validators
 * (e.g. the auth package checks identity membership) and serialize as data.
 */
export interface FieldRef {
  readonly __specFieldRef: true
  entity: string
  field: string
  unique?: boolean
  ownerNodeId: string
}

export function isFieldRef(value: unknown): value is FieldRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__specFieldRef === true
  )
}

export function fieldRef(entity: string, field: string, ownerNodeId: string, unique?: boolean): FieldRef {
  return { __specFieldRef: true, entity, field, ownerNodeId, ...(unique === undefined ? {} : { unique }) }
}

/**
 * Attribute value that survives IR serialization: field references are
 * stored as plain data (marker stripped, entity/field kept), functions are
 * dropped, and field-spec-like builders are flattened to plain data.
 */
export function serializeValue(value: unknown): unknown {
  if (typeof value === "function") return undefined
  if (value === null) return null
  if (isFieldRef(value)) {
    return { __fieldRef: true, entity: value.entity, field: value.field, owner: value.ownerNodeId }
  }
  if (isNodeBuilder(value)) {
    return toReference(value)
  }
  if (Array.isArray(value)) return value.map(serializeValue)
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    // field-spec style builders: flatten to their plain data properties
    // (data lives under non-colliding keys; see @spec/web field.ts)
    if (record.__specFieldSpec === true) {
      const flat: Record<string, unknown> = { type: record.type }
      if (record.uniqueFlag === true) flat.unique = true
      if (record.optionalFlag === true) flat.optional = true
      if (record.hasDefault === true) flat.default = serializeValue(record.defaultValue)
      return flat
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      const serialized = serializeValue(record[key])
      if (serialized !== undefined) out[key] = serialized
    }
    return out
  }
  return value
}

export { NODE_MARKER }
export type { SpecNode, SourceLocation, Constraint }
