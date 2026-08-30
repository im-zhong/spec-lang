/**
 * Field builders. `field.uuid()` etc. produce immutable FieldSpec values
 * with a chainable modifier API (`field.email().unique().optional()`).
 *
 * Data is stored under non-colliding keys (uniqueFlag, ...) so the chain
 * methods (unique(), ...) can share the object without shadowing; the
 * entity builder and the core serializer flatten these to the IR shape
 * (`{ type, unique, optional, default }`).
 */

export type FieldType = "string" | "int" | "boolean" | "uuid" | "email" | "datetime"

export const FIELD_TYPES: readonly FieldType[] = [
  "string",
  "int",
  "boolean",
  "uuid",
  "email",
  "datetime",
]

export interface FieldSpec {
  readonly __specFieldSpec: true
  readonly type: FieldType
  readonly uniqueFlag: boolean
  readonly optionalFlag: boolean
  readonly hasDefault: boolean
  readonly defaultValue: unknown
  unique(): FieldSpec
  optional(): FieldSpec
  default(value: unknown): FieldSpec
}

interface FieldData {
  type: FieldType
  uniqueFlag?: boolean
  optionalFlag?: boolean
  hasDefault?: boolean
  defaultValue?: unknown
}

export function isFieldSpec(value: unknown): value is FieldSpec {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__specFieldSpec === true
  )
}

function makeField(data: FieldData): FieldSpec {
  const base: Required<FieldData> = {
    type: data.type,
    uniqueFlag: data.uniqueFlag === true,
    optionalFlag: data.optionalFlag === true,
    hasDefault: data.hasDefault === true,
    defaultValue: data.defaultValue,
  }
  return {
    __specFieldSpec: true,
    ...base,
    unique: () => makeField({ ...base, uniqueFlag: true }),
    optional: () => makeField({ ...base, optionalFlag: true }),
    default: (value: unknown) => makeField({ ...base, hasDefault: true, defaultValue: value }),
  }
}

/**
 * Field vocabulary. Property access such as `field.email` is resolved by
 * the compiler against the trusted exports of this package.
 */
export const field = {
  string: () => makeField({ type: "string" }),
  int: () => makeField({ type: "int" }),
  boolean: () => makeField({ type: "boolean" }),
  uuid: () => makeField({ type: "uuid" }),
  email: () => makeField({ type: "email" }),
  datetime: () => makeField({ type: "datetime" }),
}
