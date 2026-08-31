/**
 * CRUD resource builder — the RESTful API vocabulary.
 *
 *   crud(User)                       → /users with list/get/create/update/delete
 *   crud(Post, { methods: ["list", "get"] })
 *
 * A crud node references its entity by deterministic node id and describes
 * the standard RESTful endpoint set a backend must expose for it. Backend
 * targets (e.g. @spec/fastapi) lower these nodes into concrete routes.
 */
import {
  isNodeBuilder,
  nodeBuilder,
  serializeValue,
  toReference,
  type SpecNodeBuilder,
} from "@spec/core"

export type CrudMethod = "list" | "get" | "create" | "update" | "delete"

export const CRUD_METHODS: readonly CrudMethod[] = [
  "list",
  "get",
  "create",
  "update",
  "delete",
]

export interface CrudInput {
  /** URL path prefix; defaults to the pluralized, kebab-cased entity name. */
  path?: string
  /** Subset of CRUD methods to expose; defaults to all five. */
  methods?: CrudMethod[]
  /** Whether endpoints require authentication (default true). */
  auth?: boolean
}

/** Naive but deterministic English pluralization. */
export function pluralize(name: string): string {
  const lower = name.toLowerCase()
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${name}es`
  if (/[^aeiou]y$/.test(lower)) return `${name.slice(0, -1)}ies`
  return `${name}s`
}

/** CamelCase / PascalCase → kebab-case ("BlogPost" → "blog-post"). */
export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase()
}

/** Default REST path for an entity: pluralized + kebab-cased. */
export function defaultCrudPath(entityName: string): string {
  return `/${kebabCase(pluralize(entityName))}`
}

export function crud(target: unknown, input: CrudInput = {}): SpecNodeBuilder {
  const attributes: Record<string, unknown> = {}

  if (isNodeBuilder(target) && target.name !== undefined) {
    attributes.entity = toReference(target)
  } else {
    // Invalid target — store raw so the validator can diagnose it with the
    // user's source location.
    attributes.entity = serializeValue(target)
  }

  const entityName =
    isNodeBuilder(target) && typeof target.name === "string" ? target.name : undefined
  attributes.path = input?.path ?? (entityName !== undefined ? defaultCrudPath(entityName) : undefined)

  if (input?.methods !== undefined) attributes.methods = [...input.methods]
  attributes.auth = input?.auth === undefined ? true : input.auth === true

  return nodeBuilder("@spec/web", "crud", entityName, attributes)
}

export interface CountInput {
  /** URL path; defaults to the entity's CRUD path + "/count". */
  path?: string
  /** Whether the endpoint requires authentication (default true). */
  auth?: boolean
}

/**
 * Count endpoint — a custom route with pinned semantics:
 * `GET <path>` returns `200 {"count": <int>}` (total rows of the entity).
 * Deterministic behavior is what makes it safely composable.
 */
export function count(target: unknown, input: CountInput = {}): SpecNodeBuilder {
  const attributes: Record<string, unknown> = {
    method: "GET",
    operation: "count",
  }

  if (isNodeBuilder(target) && target.name !== undefined) {
    attributes.entity = toReference(target)
  } else {
    attributes.entity = serializeValue(target)
  }

  const entityName =
    isNodeBuilder(target) && typeof target.name === "string" ? target.name : undefined
  attributes.path =
    input?.path ??
    (entityName !== undefined ? `${defaultCrudPath(entityName)}/count` : undefined)
  attributes.auth = input?.auth === undefined ? true : input.auth === true

  return nodeBuilder("@spec/web", "api", entityName !== undefined ? `${entityName}Count` : undefined, attributes)
}
