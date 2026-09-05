/**
 * Clause derivation: blueprint → machine-addressable node contracts.
 *
 * Every clause id derives from a stable blueprint identifier (route id,
 * invariant id, entity/field name, transition event, module export), so the
 * same spec always yields the same clause table. The clause table is the
 * single source the prompt kernel, the compiler-generated node oracle, and
 * the reviewer checklist all project from — statements below are therefore
 * contract prose, not documentation: every pinned value (status codes,
    * error bodies, export lists) must match the blueprint exactly.
 */
import type { ContractClause } from "@spec/core"
import type { BackendBlueprint, BlueprintField, BlueprintRoute } from "./blueprint"

type Verification = ContractClause["verification"]

function clause(
  node: string,
  kind: string,
  id: string,
  statement: string,
  verification: Verification = "oracle",
  level: ContractClause["level"] = "api",
): ContractClause {
  return { id, statement, node, kind, verification, level }
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function columnShape(field: BlueprintField, entityName: string, bp: BackendBlueprint): string {
  const parts: string[] = []
  if (field.type === "ref") {
    const target = bp.entities.find((e) => e.name === field.target)
    parts.push(`a string(36) column with ForeignKey(${quote(`${target?.table ?? field.target}.id`)})`)
  } else if (field.type === "enum") {
    const states = (field.states ?? []).map((s) => quote(s)).join(", ")
    const lifecycle = bp.lifecycles.find((l) => l.entity === entityName && l.field === field.name)
    parts.push(`a string column validated against {${states}}`)
    if (lifecycle) parts.push(`defaulting to the initial state ${quote(lifecycle.initial)}`)
  } else {
    parts.push(`a ${field.type} column`)
  }
  if (field.unique) parts.push("with a unique constraint")
  if (field.optional) parts.push("nullable")
  if (field.default !== undefined) parts.push(`storing the declared default ${JSON.stringify(field.default)} when omitted at insert`)
  return `${field.name} is ${parts.join(", ")}`
}

function routeBehavior(route: BlueprintRoute, bp: BackendBlueprint): string {
  const notFound = `404 ${JSON.stringify(bp.contract.errors.notFound.body)}`
  switch (route.operation) {
    case "list":
      return `list returns 200 with EVERY row as a bare JSON array ordered by created_at ascending`
    case "get":
      return `get returns 200 with the row, or ${notFound} for an unknown id`
    case "create":
      return `create returns 201 with the stored row and maps dangling ref ids to ${notFound}`
    case "update":
      return `update is a partial PATCH returning 200 with the full row, or ${notFound} for an unknown id`
    case "delete":
      return `delete returns 204 with an empty body, or ${notFound} for an unknown id`
    case "count":
      return `count returns 200 with the exact body {"count": <int>} (total rows)`
    default:
      return `${route.operation} returns ${route.status}`
  }
}

function transitionStatement(route: BlueprintRoute, bp: BackendBlueprint): string {
  const tr = route.transition!
  const guardFailed = `409 ${JSON.stringify(bp.contract.errors.guardFailed.body)}`
  const notFound = `404 ${JSON.stringify(bp.contract.errors.notFound.body)}`
  const parts = [
    `${route.method} ${route.path} atomically transitions ${tr.field} from {${tr.from.join(", ")}} to ${quote(tr.to)}`,
    `a wrong current state or failed guard answers ${guardFailed}`,
    `an unknown id answers ${notFound}`,
    `success returns ${route.status} with the updated row`,
  ]
  if (tr.guard !== undefined) parts.push(`guard expression: ${JSON.stringify(tr.guard)}`)
  if (Array.isArray(tr.effects) && tr.effects.length > 0) {
    parts.push(`effects in transaction order: ${JSON.stringify(tr.effects)}`)
  }
  return parts.join("; ")
}

function invariantStatement(invariantId: string, bp: BackendBlueprint): string {
  const inv = bp.invariants.find((i) => i.id === invariantId)!
  const violated = `409 ${JSON.stringify(bp.contract.errors.invariantViolated.body)} (row rolled back)`
  if (inv.shape === "crossRowCount") {
    const c = inv.count!
    const bound = c.bound.kind === "field" ? `<row>.${c.bound.name}` : String(c.bound.value)
    return (
      `${inv.name}: for every ${inv.entity} row, the count of ${c.entity} rows whose ${c.refField} ` +
      `points at it must be ${c.op === "lt" ? "<" : "≤"} ${bound}, enforced inside the request transaction ` +
      `on create/update of ${c.entity} and update of ${inv.entity}; violations answer ${violated}`
    )
  }
  return (
    `${inv.name}: every ${inv.entity} row must satisfy the check tree, validated on ` +
    `create/update before committing; violations answer ${violated}`
  )
}

/** Serialization clauses shared by every node that touches request/response shapes. */
function serializationClauses(node: string, bp: BackendBlueprint, createBodies: boolean): ContractClause[] {
  const clauses: ContractClause[] = [
    clause(node, "serialization", "contract:serialization:keys", "Response keys are the declared field names EXACTLY (camelCase stays camelCase)."),
    clause(node, "serialization", "contract:serialization:refs-as-ids", "ref fields serialize as the referenced row's id string."),
    clause(node, "serialization", "contract:serialization:implicit-columns-hidden", `${bp.contract.serialization.hiddenColumns.join(" and ")} are never serialized; created_at only orders lists.`),
    clause(node, "serialization", "contract:serialization:uuid4-ids", "The server generates uuid4 ids; id in request bodies is ignored."),
  ]
  if (createBodies) {
    clauses.push(clause(node, "serialization", "contract:serialization:create-defaults", "Fields with a declared default are omittable in create bodies (the default applies when omitted); optional-without-default stores null."))
  }
  return clauses
}

export function deriveClauses(bp: BackendBlueprint): ContractClause[] {
  const clauses: ContractClause[] = []

  /* ---- project ---- */
  const deps = Object.entries(bp.stack.dependencies).map(([name, version]) => `${name}==${version}`).sort()
  const dev = Object.entries(bp.stack.dev).map(([name, version]) => `${name}==${version}`).sort()
  clauses.push(
    clause("project", "pin", "pin:pyproject:name", `pyproject.toml declares project name ${quote(bp.app.name.toLowerCase())}.`),
    clause("project", "pin", "pin:pyproject:version", `pyproject.toml declares version ${quote(bp.app.version)}.`),
    clause("project", "pin", "pin:pyproject:requires-python", `requires-python is exactly ${quote(`==${bp.stack.python}.*`)}.`),
    clause("project", "pin", "pin:pyproject:dependencies", `dependencies is EXACTLY the pinned set [${deps.join(", ")}] — no additions, removals, or floated versions.`),
    clause("project", "pin", "pin:pyproject:dev-dependencies", `[project.optional-dependencies] dev is EXACTLY [${dev.join(", ")}].`),
    clause("project", "pin", "pin:pyproject:no-passlib", "passlib is never a dependency (it crashes with bcrypt >= 5; bcrypt is already pinned).", "oracle"),
    clause("project", "file", "file:app-package", "The package directory app/ exists with app/__init__.py."),
    clause("project", "file", "file:gitignore", ".gitignore covers bytecode caches and virtualenvs."),
  )

  /* ---- models ---- */
  for (const entity of bp.entities) {
    const declared = new Set(entity.fields.map((f) => f.name))
    clauses.push(
      clause("models", "column", `entity:${entity.name}:table`, `Class ${entity.name} declares __tablename__ ${quote(entity.table)} with the declared column set.`),
    )
    if (!declared.has("id")) {
      clauses.push(clause("models", "column", `entity:${entity.name}:column:id`, "id is a string uuid primary key with a uuid4 default."))
    }
    if (!declared.has("created_at")) {
      clauses.push(clause("models", "column", `entity:${entity.name}:column:created_at`, "created_at is a naive-UTC datetime column set once on insert, present on every entity."))
    }
    for (const field of entity.fields) {
      clauses.push(clause("models", "column", `entity:${entity.name}:column:${field.name}`, columnShape(field, entity.name, bp)))
    }
    if (bp.auth?.principal === entity.name && !declared.has(bp.auth.passwordColumn)) {
      clauses.push(clause("models", "column", `entity:${entity.name}:column:${bp.auth.passwordColumn}`, `${bp.auth.passwordColumn} is the implicit bcrypt-hash column on the principal ${entity.name}.`))
    }
  }
  if (bp.effects) {
    clauses.push(clause("models", "column", `outbox:${bp.effects.eventsTable}:columns`, `The outbox table ${bp.effects.eventsTable} has EXACTLY the columns id (string uuid pk), event (string), payload (string holding a JSON object), created_at (naive-UTC datetime); transitions with emit effects insert into it in-transaction and it exposes no routes.`))
  }

  /* ---- database ---- */
  clauses.push(
    clause("database", "abi", "abi:app:database:exports", "app/database.py exports exactly Base, normalize_database_url(value), resolve_database_url(explicit=None), create_engine_from_url(explicit=None), create_session_factory(engine), module defaults engine and SessionLocal, get_db(), and session_dependency(factory)."),
    clause("database", "abi", "abi:app:config:exports", "app/config.py exports only a pydantic-settings Settings class whose optional database_url field reads DATABASE_URL; it reads no dotenv file and instantiates no settings at module import."),
    clause("database", "behavior", "database:url-resolution", `URL resolution order is pinned: explicit argument → DATABASE_URL env → ${quote(bp.database.fallback)}; values are ALWAYS SQLAlchemy URLs; a non-empty bare path normalizes to sqlite:///<path>; an empty string uses the fallback.`, "oracle", "function"),
    clause("database", "behavior", "database:sessionmaker", "create_session_factory(engine) returns a synchronous sessionmaker with autoflush=False and expire_on_commit=False.", "oracle", "function"),
    clause("database", "behavior", "database:sqlite-engine", "SQLite engines use check_same_thread=False; in-memory SQLite additionally uses StaticPool.", "oracle", "function"),
    clause("database", "behavior", "database:get-db", "get_db yields from the module-default SessionLocal and always closes the session; session_dependency(factory) returns the same yielding dependency bound to the supplied factory.", "oracle", "function"),
    clause("database", "review", "review:app:database:no-extra-apis", "app/config.py and app/database.py add no caches, registries, dotenv support, lazy module attributes, or APIs beyond the declared exports.", "review"),
  )

  /* ---- schemas ---- */
  for (const entity of bp.entities) {
    const lifecycleField = bp.lifecycles.find((l) => l.entity === entity.name)?.field
    const createFields = entity.fields.filter((f) => f.name !== lifecycleField).map((f) => f.name)
    const responseFields = entity.fields.map((f) => f.name)
    clauses.push(
      clause("schemas", "serialization", `schemas:${entity.name}:create`, `The ${entity.name}Create model accepts exactly {${createFields.join(", ")}} (defaulted and optional fields omittable)${lifecycleField ? `, excluding the state field ${lifecycleField}` : ""}.`),
      clause("schemas", "serialization", `schemas:${entity.name}:update`, `The ${entity.name}Update model makes every accepted field optional — partial PATCH semantics${lifecycleField ? `, excluding the state field ${lifecycleField}` : ""}.`),
      clause("schemas", "serialization", `schemas:${entity.name}:response`, `The ${entity.name}Out model emits EXACTLY {${responseFields.join(", ")}} (never password_hash/created_at).`),
      clause("schemas", "serialization", `schemas:${entity.name}:validation`, "Field validation follows declared types: string/int/boolean/uuid/email/datetime; ref fields are id strings; enum fields validate against their states.", "oracle", "function"),
    )
    for (const field of entity.fields) {
      const parts: string[] = []
      if (field.min !== undefined) parts.push(`>= ${field.min}`)
      if (field.max !== undefined) parts.push(`<= ${field.max}`)
      if (field.maxLength !== undefined) parts.push(`length <= ${field.maxLength}`)
      if (parts.length > 0) {
        clauses.push(
          clause("schemas", "serialization", `schemas:${entity.name}:bound:${field.name}`, `${field.name} enforces ${parts.join(" and ")} on Create/Update via pydantic constraints (inclusive); violations answer the default 422 — this is validation, never the 409 invariant body.`, "oracle", "function"),
        )
      }
    }
  }
  clauses.push(...serializationClauses("schemas", bp, bp.entities.some((e) => e.fields.some((f) => f.default !== undefined))))

  /* ---- security (auth only) ---- */
  if (bp.auth) {
    clauses.push(
      clause("security", "abi", "abi:app:security:exports", "app/security.py exports hash_password, verify_password(password, password_hash | None) -> bool, create_access_token(subject) -> str, and decode_access_token(token) -> str | None."),
      clause("security", "adapter", "security:bcrypt-direct", "Password hashing uses the bcrypt package DIRECTLY (bcrypt.hashpw / bcrypt.checkpw), never passlib, and truncates secrets to 72 bytes in both hash and verify.", "oracle", "function"),
      clause("security", "behavior", "security:verify-none", "verify_password(password, None) — and any ValueError — returns False without raising.", "oracle", "function"),
      clause("security", "behavior", "security:token-roundtrip", "create_access_token(subject) followed by decode_access_token returns the subject; decode_access_token of garbage returns None; tokens carry sub = principal id with secret/expiry via env.", "oracle", "function"),
      clause("security", "behavior", "security:deps-401", `get_current_user in app/deps.py raises 401 ${JSON.stringify(bp.contract.errors.unauthenticated.body)} (exact body) for a missing or invalid token, using HTTPBearer(auto_error=False) — the default auto_error raises 403, which violates the contract.`, "oracle", "function"),
      clause("security", "review", "review:security:uuid-parse", "When models use SQLAlchemy Uuid columns, get_current_user parses uuid.UUID(sub) before db.get(...) — raw string binds against Uuid columns raise and 500.", "review", "function"),
    )
  }

  /* ---- router per served entity ---- */
  const servedEntities = [...new Set(
    bp.routes.filter((route) => route.owner.taskId !== "router:auth" && route.entity).map((route) => route.entity!),
  )].sort()
  for (const entityName of servedEntities) {
    const node = `router:${entityName}`
    const entity = bp.entities.find((e) => e.name === entityName)
    const routes = bp.routes.filter((r) => r.owner.taskId === node)
    for (const route of routes) {
      if (route.operation === "transition") {
        clauses.push(clause(node, "transition", `route:${route.id}:transition`, transitionStatement(route, bp)))
        continue
      }
      const auth = route.auth ? "bearer auth required" : "public"
      clauses.push(clause(node, "route", `route:${route.id}`, `Route ${route.method} ${route.path} exists (${auth}, success status ${route.status}); ${routeBehavior(route, bp)}.`))
      const mutates = route.operation === "create" || route.operation === "update"
      if (mutates && entity?.fields.some((f) => f.unique)) {
        clauses.push(clause(node, "error", `route:${route.id}:error:alreadyExists`, `A unique violation answers 409 ${JSON.stringify(bp.contract.errors.alreadyExists.body)}.`))
      }
    }
    const invariantIds = [...new Set(routes.flatMap((r) => r.invariantIds ?? []))].sort()
    for (const invariantId of invariantIds) {
      clauses.push(clause(node, "invariant", invariantId, invariantStatement(invariantId, bp)))
    }
    clauses.push(
      clause(node, "import", `import:${node}:no-orm-base`, "The router defines no ORM base and imports neither Base nor DeclarativeBase; all mapped classes come from app.models."),
      clause(node, "import", `import:${node}:sqlalchemy-locations`, "SQLAlchemy import locations are exact: func, select, and update from sqlalchemy; IntegrityError from sqlalchemy.exc; Session from sqlalchemy.orm; never DeclarativeBase from top-level sqlalchemy."),
    )
    const hasCount = routes.some((r) => r.operation === "count")
    const hasIdRoute = routes.some((r) => r.path.includes("{id}"))
    if (hasCount && hasIdRoute) {
      clauses.push(clause(node, "import", `import:${node}:count-before-id`, "The count route is registered BEFORE any {id} route of the same prefix."))
    }
    clauses.push(...serializationClauses(node, bp, routes.some((r) => r.operation === "create")))
  }

  /* ---- author examples (@spec/test): the strongest per-route contract ---- */
  const expectValueText = (value: unknown): string => {
    if (typeof value === "object" && value !== null) {
      const marker = (value as Record<string, unknown>).__expect
      if (marker === "notNull") return "<not-null>"
      if (marker === "any") return "<any>"
    }
    return JSON.stringify(value)
  }
  for (const example of bp.examples) {
    const route = bp.routes.find((r) => r.id === example.routeId)
    if (route === undefined) continue
    const world = example.given
      .map((f) => `${f.as}:${f.entity}${f.fields ? `=${JSON.stringify(f.fields)}` : ""}`)
      .join(", ")
    const body = example.input !== undefined ? JSON.stringify(example.input) : "(no body)"
    const match = example.expect.match === "exact" ? "exact key set" : "subset match — unpinned keys are free"
    const expected =
      example.expect.body !== undefined
        ? `a response containing {${Object.entries(example.expect.body)
            .map(([key, value]) => `${JSON.stringify(key)}: ${expectValueText(value)}`)
            .join(", ")}} (${match})`
        : "no pinned body keys"
    const stateParts: string[] = []
    for (const row of example.expect.state?.outbox ?? []) {
      stateParts.push(`the events table gains a ${JSON.stringify(row.event)} row with payload fields {${row.fields.join(", ")}} from $${row.fromAs}`)
    }
    for (const count of example.expect.state?.counts ?? []) {
      stateParts.push(`${count.entity} rows ${count.delta > 0 ? "+" : ""}${count.delta}`)
    }
    clauses.push(
      clause(
        route.owner.taskId,
        "test",
        example.id,
        `Author example ${JSON.stringify(example.name)}: with world fixtures [${world || "none"}] and request body ${body}, ${route.method} ${route.path} answers exactly ${example.expect.status} with ${expected}${stateParts.length > 0 ? `, and ${stateParts.join(", ")}` : ""}.`,
      ),
    )
  }

  /* ---- auth router ---- */
  if (bp.auth) {
    const node = "router:auth"
    const login = bp.auth.routes.find((r) => r.operation === "login")!
    const register = bp.auth.routes.find((r) => r.operation === "register")!
    const me = bp.auth.routes.find((r) => r.operation === "me")!
    clauses.push(
      clause(node, "route", `route:${login.id}`, `${login.method} ${login.path} accepts {"${bp.auth.identityField}": ..., "password": ...} and returns 200 {"access_token": "<jwt>", "token_type": "bearer"}; a wrong identity or password answers 401 ${JSON.stringify(bp.contract.errors.invalidCredentials.body)} (identical for both — no user enumeration).`),
      clause(node, "route", `route:${register.id}`, `${register.method} ${register.path} accepts the principal fields plus "password" (bcrypt-hashed before storage) and returns 201 with the principal row (never the hash); a duplicate identity answers 409 ${JSON.stringify(bp.contract.errors.alreadyExists.body)}.`),
      clause(node, "route", `route:${me.id}`, `${me.method} ${me.path} with a bearer token returns 200 with the principal row.`),
      clause(node, "serialization", "contract:serialization:never-password-hash", `${bp.auth.passwordColumn} is never serialized.`),
    )
  }

  /* ---- cache ---- */
  if (bp.caches.length > 0) {
    const node = "cache"
    clauses.push(
      clause(node, "abi", "abi:app:cache:exports", "app/cache.py exports CacheUnavailable, immutable CachePolicy, CACHE_POLICIES, InMemoryCacheBackend, and RedisCacheBackend."),
      clause(node, "abi", "cache:policy-map", "CACHE_POLICIES is a dict keyed by declared cache name containing every declaration."),
      clause(node, "behavior", "cache:inmemory-semantics", "InMemoryCacheBackend exposes async get/set/delete/get_or_set(policy_name, key[, loader]); policy_name is always the declared cache name string; values are JSON-compatible and isolated from caller mutation; in-memory TTL uses monotonic time and expired entries are misses.", "oracle", "function"),
      clause(node, "adapter", "adapter:app:cache:redis", "RedisCacheBackend(client) receives an already-connected redis.asyncio-compatible client; get awaits client.get(full_key), set awaits client.set(full_key, json_payload, ex=ttl_seconds), delete awaits client.delete(full_key); bytes are decoded before JSON parsing; full provider keys are <keyPrefix>:<key>.", "oracle", "function"),
      clause(node, "behavior", "cache:fail-closed", "A provider OSError is a miss/no-op for bypass policies and raises CacheUnavailable with the provider error preserved as its cause for fail-closed policies.", "oracle", "function"),
      clause(node, "behavior", "cache:errors", "Unknown policy names raise KeyError; empty keys raise ValueError.", "oracle", "function"),
      clause(node, "review", "review:app:cache:no-extra-apis", "No Redis client is created or connected at import time; the module adds no APIs beyond the declared exports and builds no deployment framework.", "review"),
    )
  }

  /* ---- messaging ---- */
  if (bp.queues.length > 0) {
    const node = "messaging"
    clauses.push(
      clause(node, "abi", "abi:app:messaging:exports", "app/messaging.py exports MessageValidationError, immutable MessageDefinition/QueuePolicy/MessageEnvelope (fields exactly message, version, id, occurred_at, payload), MESSAGE_DEFINITIONS, QUEUE_POLICIES, validate_payload, build_envelope, InMemoryMessageBroker, and the selected provider brokers."),
      clause(node, "abi", "messaging:maps", "MESSAGE_DEFINITIONS and QUEUE_POLICIES contain every declaration, keyed by name."),
      clause(node, "behavior", "messaging:validate-payload", "validate_payload(message, payload) rejects missing, extra, or wrongly typed fields.", "oracle", "function"),
      clause(node, "behavior", "messaging:build-envelope", "build_envelope(message, payload, *, message_id, occurred_at) validates then returns a stable version-1 envelope; datetime values serialize as ISO strings.", "oracle", "function"),
      clause(node, "behavior", "messaging:inmemory-broker", "InMemoryMessageBroker async publish(queue, envelope) rejects messages not allowed by the queue, deduplicates message ids for at-least-once queues, and drain(queue) preserves publish order.", "oracle", "function"),
    )
    const providers = [...new Set(bp.queues.map((q) => q.provider.kind))].sort()
    for (const provider of providers) {
      const shape =
        provider === "kafka"
          ? "KafkaBroker.publish awaits client.send_and_wait(queue_name, payload_bytes, key=ordering_key_bytes); the key is the declared ordering field encoded UTF-8, or the message id when the queue declares none"
          : provider === "rabbitmq"
            ? "RabbitMQBroker.publish awaits client.publish(queue_name, payload_bytes, message_id=envelope.id)"
            : "SQSBroker.publish runs client.send_message(QueueUrl=queue_name, MessageBody=payload_text, MessageDeduplicationId=envelope.id, MessageGroupId=ordering_value_or_id) through asyncio.to_thread"
      clauses.push(clause(node, "adapter", `adapter:app:messaging:${provider}`, `Provider adapter ${shape}; it receives its already-connected client in the constructor, validates the queue/message before any client call, uses deterministic compact JSON (sort_keys=True, separators (',', ':')), and propagates provider errors unchanged.`, "oracle", "function"))
    }
    clauses.push(clause(node, "review", "review:app:messaging:no-extra-apis", "No provider client is created or connected at import time; the module adds no APIs beyond the declared exports and builds no worker/runtime orchestration.", "review"))
  }

  /* ---- blob ---- */
  if (bp.blobs.length > 0) {
    const node = "blob"
    const selectorName = bp.moduleAbis.blob?.selector.name ?? "policy_name"
    clauses.push(
      clause(node, "abi", "abi:app:blob:exports", "app/blob.py exports BlobValidationError, immutable BlobPolicy, BLOB_POLICIES, normalize_blob_key, InMemoryBlobStore, and S3BlobStore."),
      clause(node, "abi", "blob:policy-map", "BLOB_POLICIES is a dict keyed by declared blob name containing every declaration."),
      clause(node, "selector", `selector:app:blob:${selectorName}`, `normalize_blob_key(${selectorName}, key) receives the declared policy name as a string and returns <keyPrefix>/<key> without duplicate separators, rejecting absolute paths, dot segments, and empty keys.`, "oracle", "function"),
      clause(node, "behavior", "blob:inmemory-store", "InMemoryBlobStore exposes async put(policy_name, key, data, content_type), get, delete, and signed_url; byte limit and MIME allowlist are enforced before storing; missing objects raise KeyError; signed URLs are exactly memory://<bucket>/<normalized-key>?expires=<ttl>.", "oracle", "function"),
      clause(node, "adapter", "adapter:app:blob:s3", "S3BlobStore(client) receives an already-configured boto3-compatible client and implements the same four async methods: put calls client.put_object(Bucket=..., Key=..., Body=..., ContentType=...), get calls client.get_object(...) and returns response[\"Body\"].read(), delete calls client.delete_object(...), signed_url calls client.generate_presigned_url(\"get_object\", Params={...}, ExpiresIn=<declared ttl>); every blocking call and body read runs through asyncio.to_thread.", "oracle", "function"),
      clause(node, "review", "review:app:blob:no-extra-apis", "No S3 client is created or contacted during module import; the module adds no APIs beyond the declared exports.", "review"),
    )
  }

  /* ---- app skeleton (walking skeleton: boots before routers exist) ---- */
  clauses.push(
    clause("app", "abi", "abi:app:main:exports", "app/main.py exports create_app(database_url: str | None = None) -> FastAPI AND a module-level app = create_app()."),
    clause("app", "app", "app:title-version", `The application title is ${quote(bp.app.title)} and the version ${quote(bp.app.version)}.`),
    clause("app", "app", "app:routes-grow", "The skeleton registers no routes of its own: ROUTERS is imported from the compiler-owned app.router_registry and each existing entry is included exactly once in tuple order — every router that lands on main grows the live route set, and the COMPLETE declared interface is asserted once by terminal conformance (strict OpenAPI equality)."),
    clause("app", "app", "app:router-registry", "The registry is detection-based: CANDIDATES are the pinned router modules in pinned order and a candidate is imported only when its module exists — importing app.router_registry never raises, including with zero routers present.", "oracle", "function"),
    clause("app", "app", "app:engine-isolation", "When app.database exists, each create_app call creates one engine via create_engine_from_url(database_url) and one session factory, stores them on app.state, overrides get_db with session_dependency(factory), creates tables on startup against that engine, and disposes it on shutdown; with no database module yet the skeleton accepts database_url and wires nothing — create_app never raises because a dependency module is absent.", "oracle", "function"),
    clause("app", "app", "app:state-adapters", "Deterministic in-memory cache, messaging, and blob adapters are constructed and exposed as app.state.cache, app.state.messaging, and app.state.blob exactly when the corresponding app module exists (detection wiring, never a hard import).", "oracle", "function"),
  )

  return clauses
}

/** Clauses grouped per generation node id, matching buildTaskDag's task set exactly. */
export function clausesByTask(bp: BackendBlueprint): Map<string, ContractClause[]> {
  const grouped = new Map<string, ContractClause[]>()
  for (const clause of deriveClauses(bp)) {
    const list = grouped.get(clause.node) ?? []
    list.push(clause)
    grouped.set(clause.node, list)
  }
  for (const [node, list] of grouped) {
    grouped.set(node, [...list].sort((left, right) => left.id.localeCompare(right.id)))
  }
  return grouped
}
