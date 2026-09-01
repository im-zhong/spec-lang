/**
 * FastAPI server builder — the backend target node.
 *
 *   fastapi({ services: [Users, MainAuth], resources: [MainDB] })
 *
 * The node references the services it serves (crud resources, custom api
 * routes, auth services) and the storage resources it binds to. Serving
 * crud resources implies a relational store, expressed as a capability
 * requirement checked by the compiler's link pass (layer 5).
 */
import {
  isNodeBuilder,
  nodeBuilder,
  serializeValue,
  toReference,
  type SpecNodeBuilder,
} from "@spec/core"

export const FASTAPI_REQUIRES = ["RelationalStore"]

/**
 * Stack overrides: exact version pins merged onto the target package's
 * validated defaults. Pinning the stack is part of the golden rule —
 * floating versions make repeatability a coincidence of install dates.
 *   fastapi({ stack: { fastapi: "0.141.1", dependencies: { pydantic: "2.13.5" } } })
 */
export interface FastApiStackInput {
  /** Python minor version, e.g. "3.13". */
  python?: string
  /** Runtime dependency pins (name → exact version). */
  dependencies?: Record<string, string>
  /** Dev/test dependency pins (name → exact version). */
  dev?: Record<string, string>
}

export interface FastApiInput {
  /** OpenAPI title; defaults to the app name. */
  title?: string
  version?: string
  /** Route prefix for every endpoint (e.g. "/api"); default "". */
  prefix?: string
  /** Development server port; default 8000. */
  port?: number
  /** crud / api / auth nodes this server exposes. */
  services?: unknown
  /** Storage resources (e.g. postgres(...)) this server binds to. */
  resources?: unknown
  /** Technology stack pins (merged onto @spec/fastapi's defaults). */
  stack?: FastApiStackInput
  [key: string]: unknown
}

function refList(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  return value.map((item) =>
    isNodeBuilder(item) ? toReference(item) : serializeValue(item),
  )
}

export function fastapi(input: FastApiInput): SpecNodeBuilder {
  const services = refList(input?.services)
  const resources = refList(input?.resources)

  const attributes: Record<string, unknown> = {
    title: input?.title,
    version: input?.version ?? "0.1.0",
    prefix: input?.prefix ?? "",
    port: input?.port ?? 8000,
    services,
    resources,
  }

  // Serving crud resources (or an auth service) requires a relational
  // store — the link pass resolves this against providers (e.g. postgres).
  const servesCrud = services.some(
    (s) => isPlainRef(s) && typeof s.nodeId === "string" && s.nodeId.startsWith("crud:"),
  )
  const servesAuth = services.some(
    (s) => isPlainRef(s) && typeof s.nodeId === "string" && s.nodeId.startsWith("auth:"),
  )
  if (servesCrud || servesAuth) {
    attributes.requires = [...FASTAPI_REQUIRES]
  }

  // Stack pins are part of the specification: store the overrides (the
  // blueprint merges them onto the pinned defaults).
  if (input?.stack !== undefined) {
    attributes.stack = serializeValue(input.stack)
  }

  return nodeBuilder("@spec/fastapi", "fastapi", undefined, attributes)
}

function isPlainRef(value: unknown): value is { nodeId: unknown } {
  return typeof value === "object" && value !== null && "nodeId" in value
}
