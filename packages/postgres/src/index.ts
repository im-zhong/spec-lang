/**
 * PostgreSQL resource package.
 *
 * MVP only *describes* a database resource (and which entities it stores);
 * it never creates a real database. It provides the RelationalStore
 * capability that e.g. @spec/auth requires.
 */
import {
  isNodeBuilder,
  nodeBuilder,
  serializeValue,
  toReference,
  type SpecNodeBuilder,
} from "@spec/core"

export const POSTGRES_PROVIDES = ["RelationalStore"]

export interface PostgresInput {
  entities?: unknown
  database?: string
  [key: string]: unknown
}

export function postgres(input: PostgresInput): SpecNodeBuilder {
  const entities: unknown[] = Array.isArray(input?.entities) ? input.entities : []
  const entityRefs = entities.map((e) =>
    isNodeBuilder(e) ? toReference(e) : serializeValue(e),
  )
  return nodeBuilder("@spec/postgres", "postgres", undefined, {
    entities: entityRefs,
    provides: [...POSTGRES_PROVIDES],
    ...(input && "database" in input ? { database: serializeValue(input.database) } : {}),
  })
}

export { default as postgresPackage } from "./spec-package"
