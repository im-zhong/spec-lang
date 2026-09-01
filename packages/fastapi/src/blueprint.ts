/**
 * Backend blueprint: the deterministic derivation
 *
 *     Spec IR  ──(pure function)──►  BackendBlueprint
 *
 * The blueprint is the contract between the traditional compiler half and
 * the coding-agent half — and it is what makes generation REPEATABLE
 * (the golden rule: same spec ⇒ same behavior, same interfaces, same
 * responses, across independent generations).
 *
 * Everything an HTTP client can observe is pinned here: route paths,
 * methods, status codes, request/response schemas, error bodies, auth
 * flow, list ordering. The agent implements this contract; the compiler's
 * conformance suite (see conformance.ts) verifies it byte-for-byte.
 */
import type { SpecIR, SpecNode } from "@spec/core"
import { CRUD_METHODS, type CrudMethod } from "@spec/web"

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"

export type RouteOperation =
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete"
  | "transition"
  | "login"
  | "register"
  | "me"
  | "count"

export interface BlueprintField {
  name: string
  /** snake_case column name. */
  column: string
  type: "string" | "int" | "boolean" | "uuid" | "email" | "datetime" | "ref" | "enum"
  /** For ref fields: referenced entity name. */
  target?: string
  /** For enum fields: the closed set of states. */
  states?: string[]
  unique?: boolean
  optional?: boolean
  default?: unknown
}

export interface BlueprintEntity {
  name: string
  /** snake_case plural table name. */
  table: string
  fields: BlueprintField[]
  /** Implicit password column for the auth principal (never serialized). */
  passwordColumn?: string
}

/** Pinned response semantics per operation. */
export interface BlueprintRoute {
  /** Deterministic route id, e.g. "POST /api/posts". */
  id: string
  method: HttpMethod
  /** Includes the prefix; path params use {id}. */
  path: string
  operation: RouteOperation
  entity?: string
  /** Success status code. */
  status: number
  /** Requires a bearer token. */
  auth: boolean
  /** Body fields accepted (request); undefined = no body. */
  request?: { shape: Record<string, string>; partial?: boolean }
  /** Response semantics. */
  response: { kind: "entity" | "entityArray" | "empty" | "token" | "count"; entity?: string }
  /** For transition routes: the state machine edge being lowered. */
  transition?: { field: string; event: string; from: string[]; to: string }
}

/** A served lifecycle (behavior Phase 1): entity + state machine. */
export interface BlueprintLifecycle {
  entity: string
  field: string
  initial: string
  transitions: Array<{ event: string; from: string[]; to: string }>
}

export interface BlueprintAuth {
  strategy: "password-jwt"
  principal: string
  identityField: string
  /** Column storing the bcrypt hash. */
  passwordColumn: string
  routes: BlueprintRoute[]
}

/**
 * The behavioral contract every generation must satisfy identically.
 * These values are pinned (not agent choices) — that is the golden rule.
 */
export interface BackendContract {
  serialization: {
    /** JSON keys are the field names exactly as declared in the spec. */
    entityKeys: "declaredFieldNames"
    /** ref fields serialize as the referenced row's id string. */
    refFields: "referencedIdString"
    /** Implicit auth column — never present in any response. */
    hiddenColumns: string[]
    /** list endpoints return a bare JSON array. */
    listShape: "bareArray"
    /** Implicit created_at orders list results ascending; never serialized. */
    listOrder: "createdAtAscending"
    /** list returns EVERY row of the entity — including the requesting
     * principal when the listed entity is the principal. No requester
     * filtering of any kind. */
    listScope: "allRows"
    /** Server generates uuid4 ids; id is ignored in create bodies. */
    idGeneration: "serverUuid4"
    /** Fields with defaults are omittable in create bodies; the declared
     * default applies when omitted. Optional-without-default stores null. */
    createDefaults: "omittable-appliesDefault"
  }
  errors: {
    unauthenticated: { status: 401; body: { detail: "Not authenticated" } }
    invalidCredentials: { status: 401; body: { detail: "Invalid credentials" } }
    notFound: { status: 404; body: { detail: "Not found" } }
    /** Unknown ref target on create/update behaves like notFound. */
    danglingRef: { status: 404; body: { detail: "Not found" } }
    /** Unique-field violations on create/update/register. */
    alreadyExists: { status: 409; body: { detail: "Already exists" } }
    /** A lifecycle transition whose guard (current state) fails. */
    guardFailed: { status: 409; body: { detail: "Invalid state" } }
    /** Field validation failures use the framework default (422). */
    validation: { status: 422; body: "fastapi-default" }
  }
  auth: {
    scheme: "bearer-jwt"
    loginRequest: Record<string, string>
    registerRequest: Record<string, string>
    loginResponse: { access_token: "string"; token_type: "bearer" }
  }
}

export interface BackendBlueprint {
  app: {
    name: string
    title: string
    version: string
    prefix: string
    port: number
  }
  entities: BlueprintEntity[]
  routes: BlueprintRoute[]
  lifecycles: BlueprintLifecycle[]
  auth?: BlueprintAuth
  database: {
    engine: "postgres" | "sqlite"
    urlEnv: string
    /** SQLite fallback used when urlEnv is unset (dev + tests). */
    fallback: string
    /** database_url values are SQLAlchemy URL strings, never bare paths. */
    urlFormat: "sqlalchemy-url"
  }
  /** The pinned technology stack — part of the contract. */
  stack: BackendStack
  contract: BackendContract
}

/**
 * The technology stack, pinned to EXACT versions. Repeatability across
 * time (not just across shots) requires that two generations resolve
 * identical dependencies; floating versions made that a coincidence of
 * install dates. Defaults are owned by @spec/fastapi and validated by the
 * golden-rule runs; specifications may override individual pins via
 * `fastapi({ stack: { fastapi: "0.141.1" } })`.
 */
export interface BackendStack {
  /** Python minor version used for generation + verification. */
  python: string
  /** Runtime dependencies (name → exact version spec). */
  dependencies: Record<string, string>
  /** Dev/test dependencies (name → exact version spec). */
  dev: Record<string, string>
}

export const DEFAULT_FASTAPI_STACK: BackendStack = {
  python: "3.13",
  dependencies: {
    fastapi: "0.141.1",
    uvicorn: "0.52.4",
    sqlalchemy: "2.0.52",
    pydantic: "2.13.5",
    "pydantic-settings": "2.15.0",
    pyjwt: "2.13.0",
    bcrypt: "5.0.0",
    "email-validator": "2.2.0",
  },
  dev: {
    pytest: "9.1.1",
    httpx: "0.28.1",
  },
}

/** Merge spec-level stack overrides onto the pinned defaults. */
export function resolveStack(overrides: unknown): BackendStack {
  const merged: BackendStack = {
    python: DEFAULT_FASTAPI_STACK.python,
    dependencies: { ...DEFAULT_FASTAPI_STACK.dependencies },
    dev: { ...DEFAULT_FASTAPI_STACK.dev },
  }
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    const record = overrides as Record<string, unknown>
    if (typeof record.python === "string") merged.python = record.python
    for (const section of ["dependencies", "dev"] as const) {
      const given = record[section]
      if (given && typeof given === "object" && !Array.isArray(given)) {
        for (const [name, version] of Object.entries(given as Record<string, unknown>)) {
          if (typeof version === "string") merged[section][name] = version
        }
      }
    }
  }
  merged.dependencies = sortRecord(merged.dependencies)
  merged.dev = sortRecord(merged.dev)
  return merged
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** snake_case("BlogPost") → "blog_post". */
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s\-]+/g, "_")
    .toLowerCase()
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function crudMethods(node: SpecNode): CrudMethod[] {
  const declared = node.attributes.methods
  if (Array.isArray(declared)) {
    const valid = declared.filter(
      (m): m is CrudMethod =>
        typeof m === "string" && (CRUD_METHODS as readonly string[]).includes(m),
    )
    if (valid.length > 0) return valid
  }
  return [...CRUD_METHODS]
}

/** Request body shape for create: all fields except the id column. */
function createRequestShape(
  entity: BlueprintEntity,
  lifecycleField?: string,
): Record<string, string> {
  const shape: Record<string, string> = {}
  for (const field of entity.fields) {
    if (field.name === "id") continue
    if (field.name === lifecycleField) continue // server assigns the initial state
    shape[field.name] = field.type === "ref" ? `ref:${field.target ?? ""}` : field.type
    if (field.optional) shape[field.name] = `${shape[field.name]}?`
  }
  return shape
}

/**
 * Derive the backend blueprint from a compiled Spec IR.
 *
 * Pure and total: unknown/invalid shapes degrade to omitted pieces (the
 * static validators will already have produced diagnostics for them).
 */
export function buildBlueprint(ir: SpecIR): BackendBlueprint {
  const nodes = flatten(ir.nodes)
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const appNode = nodes.find((n) => n.kind === "app")
  const serverNode = nodes.find((n) => n.kind === "fastapi")

  const appName = String(appNode?.attributes.name ?? appNode?.name ?? ir.app.name ?? "App")
  const prefix = String(serverNode?.attributes.prefix ?? "")

  /* ---------------- entities + auth detection ---------------- */
  const authNode = nodes.find((n) => n.kind === "auth")
  let principalName: string | undefined
  let identityField: string | undefined
  if (authNode) {
    const principalRef = authNode.attributes.principal
    if (isPlainObject(principalRef) && typeof principalRef.nodeId === "string") {
      principalName = byId.get(principalRef.nodeId)?.name
    }
    const strategy = (authNode.children ?? []).find((c) => c.kind === "passwordStrategy")
    const identity = strategy?.attributes.identity
    if (isPlainObject(identity) && typeof identity.field === "string") {
      identityField = identity.field
    }
  }

  const entities: BlueprintEntity[] = []
  for (const node of nodes.filter((n) => n.kind === "entity")) {
    const fields: BlueprintField[] = []
    const fieldsAttr = node.attributes.fields
    if (isPlainObject(fieldsAttr)) {
      for (const [fieldName, def] of Object.entries(fieldsAttr)) {
        if (!isPlainObject(def) || typeof def.type !== "string") continue
        const field: BlueprintField = {
          name: fieldName,
          column: snakeCase(fieldName),
          type: def.type as BlueprintField["type"],
        }
        if (typeof def.target === "string") field.target = def.target
        if (Array.isArray(def.states)) field.states = [...(def.states as string[])]
        if (def.unique === true) field.unique = true
        if (def.optional === true) field.optional = true
        if (def.default !== undefined) field.default = def.default
        fields.push(field)
      }
    }
    const entity: BlueprintEntity = {
      name: node.name ?? "Entity",
      table: `${snakeCase(node.name ?? "entity")}s`,
      fields,
    }
    if (principalName !== undefined && node.name === principalName) {
      entity.passwordColumn = "password_hash"
    }
    entities.push(entity)
  }

  const entityByName = new Map(entities.map((e) => [e.name, e]))

  /* ---------------- served services ---------------- */
  const serviceRefs = serverNode?.attributes.services
  const servedIds = new Set(
    Array.isArray(serviceRefs)
      ? serviceRefs
          .filter((s): s is { nodeId: string } => isPlainObject(s) && typeof s.nodeId === "string")
          .map((s) => s.nodeId)
      : [],
  )
  const isServed = (node: SpecNode): boolean => !serverNode || servedIds.has(node.id)

  /* ---------------- routes ---------------- */
  const routes: BlueprintRoute[] = []

  // Auth only protects routes when an auth service is actually served.
  const authActive =
    !!authNode && isServed(authNode) && principalName !== undefined && entityByName.has(principalName)

  // Served lifecycles: entity name → { field, initial } (Phase 1 of
  // docs/behavior-model.md — transitions derive below, after crud paths).
  const lifecycles = new Map<string, { field: string; initial: string }>()
  for (const node of nodes.filter((n) => n.kind === "lifecycle")) {
    if (!isServed(node)) continue
    const targetRef = node.attributes.entity
    const targetId =
      isPlainObject(targetRef) && typeof targetRef.nodeId === "string" ? targetRef.nodeId : undefined
    const entityName = targetId ? byId.get(targetId)?.name : undefined
    if (!entityName) continue
    if (typeof node.attributes.field === "string" && typeof node.attributes.initial === "string") {
      lifecycles.set(entityName, { field: node.attributes.field, initial: node.attributes.initial })
    }
  }

  for (const node of nodes.filter((n) => n.kind === "crud")) {
    if (!isServed(node)) continue
    const targetRef = node.attributes.entity
    const targetId =
      isPlainObject(targetRef) && typeof targetRef.nodeId === "string" ? targetRef.nodeId : undefined
    const entityName = targetId ? byId.get(targetId)?.name : undefined
    if (!entityName) continue
    const entity = entityByName.get(entityName)
    if (!entity) continue

    const methods = crudMethods(node)
    const auth = authActive && node.attributes.auth !== false
    const path = String(node.attributes.path ?? `/${entityName.toLowerCase()}s`)
    const base = `${prefix}${path}`
    const lifecycle = lifecycles.get(entityName)
    const request = createRequestShape(entity, lifecycle?.field)

    if (methods.includes("list")) {
      routes.push({
        id: `GET ${base}`,
        method: "GET",
        path: base,
        operation: "list",
        entity: entityName,
        status: 200,
        auth,
        response: { kind: "entityArray", entity: entityName },
      })
    }
    if (methods.includes("get")) {
      routes.push({
        id: `GET ${base}/{id}`,
        method: "GET",
        path: `${base}/{id}`,
        operation: "get",
        entity: entityName,
        status: 200,
        auth,
        response: { kind: "entity", entity: entityName },
      })
    }
    if (methods.includes("create")) {
      routes.push({
        id: `POST ${base}`,
        method: "POST",
        path: base,
        operation: "create",
        entity: entityName,
        status: 201,
        auth,
        request: { shape: request },
        response: { kind: "entity", entity: entityName },
      })
    }
    if (methods.includes("update")) {
      routes.push({
        id: `PATCH ${base}/{id}`,
        method: "PATCH",
        path: `${base}/{id}`,
        operation: "update",
        entity: entityName,
        status: 200,
        auth,
        request: { shape: request, partial: true },
        response: { kind: "entity", entity: entityName },
      })
    }
    if (methods.includes("delete")) {
      routes.push({
        id: `DELETE ${base}/{id}`,
        method: "DELETE",
        path: `${base}/{id}`,
        operation: "delete",
        entity: entityName,
        status: 204,
        auth,
        response: { kind: "empty" },
      })
    }
  }

  /* ---------------- api nodes (count) ---------------- */
  for (const node of nodes.filter((n) => n.kind === "api")) {
    if (!isServed(node)) continue
    if (node.attributes.operation !== "count") continue
    const targetRef = node.attributes.entity
    const targetId =
      isPlainObject(targetRef) && typeof targetRef.nodeId === "string" ? targetRef.nodeId : undefined
    const entityName = targetId ? byId.get(targetId)?.name : undefined
    if (!entityName) continue
    const path = String(node.attributes.path ?? `/${entityName.toLowerCase()}s/count`)
    const fullPath = `${prefix}${path}`
    routes.push({
      id: `GET ${fullPath}`,
      method: "GET",
      path: fullPath,
      operation: "count",
      entity: entityName,
      status: 200,
      auth: authActive && node.attributes.auth !== false,
      response: { kind: "count" },
    })
  }

  /* ---------------- lifecycle transitions (behavior Phase 1) ---------------- */
  const blueprintLifecycles: BlueprintLifecycle[] = []
  for (const node of nodes.filter((n) => n.kind === "lifecycle")) {
    if (!isServed(node)) continue
    const targetRef = node.attributes.entity
    const targetId =
      isPlainObject(targetRef) && typeof targetRef.nodeId === "string" ? targetRef.nodeId : undefined
    const entityName = targetId ? byId.get(targetId)?.name : undefined
    if (!entityName || !entityByName.has(entityName)) continue
    const field = String(node.attributes.field ?? "")
    const transitions = Array.isArray(node.attributes.transitions) ? node.attributes.transitions : []
    const declared = transitions
      .filter((raw): raw is Record<string, unknown> => isPlainObject(raw))
      .filter((raw) => typeof raw.event === "string" && typeof raw.to === "string")
      .map((raw) => ({
        event: String(raw.event),
        from: (Array.isArray(raw.from) ? raw.from : []).filter(
          (s): s is string => typeof s === "string",
        ),
        to: String(raw.to),
      }))
    if (declared.length > 0 && typeof node.attributes.initial === "string") {
      blueprintLifecycles.push({
        entity: entityName,
        field,
        initial: String(node.attributes.initial),
        transitions: declared,
      })
    }

    // Path base mirrors the entity's CRUD resource when one exists.
    const crudNode = nodes.find(
      (n) => n.kind === "crud" && n.attributes.entity &&
        isPlainObject(n.attributes.entity) && (n.attributes.entity as { nodeId?: string }).nodeId === targetId,
    )
    const base = crudNode
      ? `${prefix}${String(crudNode.attributes.path ?? `/${entityName.toLowerCase()}s`)}`
      : `${prefix}/${entityName.toLowerCase()}s`

    for (const raw of transitions) {
      if (!isPlainObject(raw)) continue
      const event = String(raw.event)
      const to = typeof raw.to === "string" ? raw.to : ""
      const from = Array.isArray(raw.from) ? (raw.from as string[]).filter((s) => typeof s === "string") : []
      if (!event || !to) continue
      const path = `${base}/{id}/${event}`
      routes.push({
        id: `POST ${path}`,
        method: "POST",
        path,
        operation: "transition",
        entity: entityName,
        status: 200,
        auth: authActive,
        response: { kind: "entity", entity: entityName },
        transition: { field, event, from: [...from].sort(), to },
      })
    }
  }

  /* ---------------- auth routes ---------------- */
  let auth: BlueprintAuth | undefined
  let identity = "email"
  if (authActive && principalName !== undefined) {
    const principal = entityByName.get(principalName)!
    identity = identityField && principal.fields.some((f) => f.name === identityField)
      ? identityField
      : (principal.fields.find((f) => f.unique)?.name ?? principal.fields[0]?.name ?? "id")
    auth = {
      strategy: "password-jwt",
      principal: principalName,
      identityField: identity,
      passwordColumn: "password_hash",
      routes: [
        {
          id: `POST ${prefix}/auth/login`,
          method: "POST",
          path: `${prefix}/auth/login`,
          operation: "login",
          entity: principalName,
          status: 200,
          auth: false,
          request: { shape: { [identity]: "string", password: "string" } },
          response: { kind: "token" },
        },
        {
          id: `POST ${prefix}/auth/register`,
          method: "POST",
          path: `${prefix}/auth/register`,
          operation: "register",
          entity: principalName,
          status: 201,
          auth: false,
          request: {
            shape: {
              ...createRequestShape(principal),
              password: "string",
            },
          },
          response: { kind: "entity", entity: principalName },
        },
        {
          id: `GET ${prefix}/auth/me`,
          method: "GET",
          path: `${prefix}/auth/me`,
          operation: "me",
          entity: principalName,
          status: 200,
          auth: true,
          response: { kind: "entity", entity: principalName },
        },
      ],
    }
    routes.push(...auth.routes)
  }

  /* ---------------- database ---------------- */
  const databaseNode = nodes.find(
    (n) => n.kind === "postgres" || n.kind === "sqlite" || n.kind === "database",
  )
  const engine: "postgres" | "sqlite" = databaseNode?.kind === "sqlite" ? "sqlite" : "postgres"

  /* ---------------- stack (pinned, spec-overridable) ---------------- */
  const stack = resolveStack(serverNode?.attributes.stack)

  /* ---------------- pinned contract ---------------- */
  const contract: BackendContract = {
    serialization: {
      entityKeys: "declaredFieldNames",
      refFields: "referencedIdString",
      hiddenColumns: ["password_hash", "created_at"],
      listShape: "bareArray",
      listOrder: "createdAtAscending",
      listScope: "allRows",
      idGeneration: "serverUuid4",
      createDefaults: "omittable-appliesDefault",
    },
    errors: {
      unauthenticated: { status: 401, body: { detail: "Not authenticated" } },
      invalidCredentials: { status: 401, body: { detail: "Invalid credentials" } },
      notFound: { status: 404, body: { detail: "Not found" } },
      danglingRef: { status: 404, body: { detail: "Not found" } },
      alreadyExists: { status: 409, body: { detail: "Already exists" } },
      guardFailed: { status: 409, body: { detail: "Invalid state" } },
      validation: { status: 422, body: "fastapi-default" },
    },
    auth: {
      scheme: "bearer-jwt",
      loginRequest: { [identity]: "string", password: "string" },
      registerRequest: {
        ...(auth ? createRequestShape(entityByName.get(auth.principal)!) : {}),
        password: "string",
      },
      loginResponse: { access_token: "string", token_type: "bearer" },
    },
  }

  return {
    app: {
      name: appName,
      title: String(serverNode?.attributes.title ?? appName),
      version: String(serverNode?.attributes.version ?? "0.1.0"),
      prefix,
      port: Number(serverNode?.attributes.port ?? 8000),
    },
    entities,
    routes,
    lifecycles: blueprintLifecycles,
    ...(auth ? { auth } : {}),
    database: { engine, urlEnv: "DATABASE_URL", fallback: "sqlite:///./dev.db", urlFormat: "sqlalchemy-url" },
    stack,
    contract,
  }
}
