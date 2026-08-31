/**
 * Field builders. `field.uuid()` etc. produce immutable FieldSpec values
 * with a chainable modifier API (`field.email().unique().optional()`).
 *
 * Data is stored under non-colliding keys (uniqueFlag, ...) so the chain
 * methods (unique(), ...) can share the object without shadowing; the
 * entity builder and the core serializer flatten these to the IR shape
 * (`{ type, unique, optional, default }`).
 */

export type FieldType =
  | "string"
  | "int"
  | "boolean"
  | "uuid"
  | "email"
  | "datetime"
  | "ref"

export const FIELD_TYPES: readonly FieldType[] = [
  "string",
  "int",
  "boolean",
  "uuid",
  "email",
  "datetime",
  "ref",
]

export interface FieldSpec {
  readonly __specFieldSpec: true
  readonly type: FieldType
  readonly uniqueFlag: boolean
  readonly optionalFlag: boolean
  readonly hasDefault: boolean
  readonly defaultValue: unknown
  /** For `ref` fields: the referenced entity's name. */
  readonly refTarget?: string
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
  refTarget?: string
}

export function isFieldSpec(value: unknown): value is FieldSpec {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__specFieldSpec === true
  )
}

function makeField(data: FieldData): FieldSpec {
  const base: Omit<Required<FieldData>, "refTarget"> & { refTarget?: string } = {
    type: data.type,
    uniqueFlag: data.uniqueFlag === true,
    optionalFlag: data.optionalFlag === true,
    hasDefault: data.hasDefault === true,
    defaultValue: data.defaultValue,
  }
  return {
    __specFieldSpec: true,
    ...base,
    ...(data.refTarget === undefined ? {} : { refTarget: data.refTarget }),
    unique: () => makeField({ ...data, ...base, uniqueFlag: true }),
    optional: () => makeField({ ...data, ...base, optionalFlag: true }),
    default: (value: unknown) => makeField({ ...data, ...base, hasDefault: true, defaultValue: value }),
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
  /** Reference to another entity (foreign key): `field.ref("User")`. */
  ref: (target: string) => makeField({ type: "ref", refTarget: target }),
}
