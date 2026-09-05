/**
 * Compiler-generated node oracles.
 *
 * One clause table, one projection: each generation node receives a frozen
 * pytest file under tests/spec_oracle/ that mechanically verifies the
 * node's oracle-verifiable clauses (import surface, route tables, column
 * metadata, pins, schema field sets, pure module behaviors, and the app's
 * OpenAPI route interface). The files are compiler-owned — materialized
 * with the seed, identical in every shot, byte-identical from round 1 to
 * round N.
 *
 * Oracle v2 — router nodes also get BEHAVIOR probes in-loop: the oracle
 * assembles a throwaway app (FastAPI + only this router + in-memory
 * SQLite + a get_db override) and interprets the same {given, input,
 * expect} triples the conformance suite runs terminally. Behavior defects
 * die in round 1 instead of detonating at the single-shot conformance
 * judgment. Fixtures are seeded by DIRECT table inserts (sibling routers
 * do not exist yet); values are compiled literals — deterministic uuids,
 * guard-directed samples — so the whole contract is byte-stable.
 *
 * Style: contract embedding. Every test file is the same three lines plus
 * a CONTRACT JSON literal; runner.py is a single generic interpreter of
 * that data (the same pattern as conformance/test_infrastructure.py).
 */
import { stableStringify } from "@spec/core"
import type { BackendBlueprint, BlueprintEntity, BlueprintField, BlueprintRoute } from "./blueprint"
import type { DagTask } from "./dag"

export const ORACLE_DIR = "tests/spec_oracle"

export function safeTaskSegment(taskId: string): string {
  return taskId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}

export function oracleFileFor(taskId: string): string {
  return `${ORACLE_DIR}/test_${safeTaskSegment(taskId)}.py`
}

function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The pinned uv invocation that runs one oracle file. */
export function testCommandFor(bp: BackendBlueprint, testFile: string): string {
  const packages = Object.entries({ ...bp.stack.dependencies, ...bp.stack.dev })
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, version]) => ["--with", shellWord(`${name}==${version}`)])
  return [
    "uv", "run", "--no-project", "--python", shellWord(bp.stack.python),
    ...packages,
    "python", "-B", "-m", "pytest", "-p", "no:cacheprovider", "-q", testFile,
  ].join(" ")
}

function normalizeCaseTable(bp: BackendBlueprint): Array<[string, string]> {
  const fallback = bp.database.fallback
  const cases: Array<[string, string]> = [
    ["data.db", `sqlite:///data.db`],
    ["", fallback],
    ["sqlite:///existing.db", "sqlite:///existing.db"],
    ["postgresql+psycopg://host/db", "postgresql+psycopg://host/db"],
  ]
  return cases
}

/* ==================== behavior compiler (oracle v2) ====================
 *
 * Router nodes lower to interpretable {given, request, expect} triples:
 * the runner assembles a throwaway app (only this router + in-memory
 * SQLite + get_db override), seeds fixtures by direct table insert, sends
 * the compiled request, and asserts the compiled expectation. Every value
 * is a compiled literal (deterministic uuids, guard-directed samples), so
 * the behavior block is byte-stable like the rest of the contract. */

const UNKNOWN_UUID = "ffffffff-ffff-4fff-8fff-ffffffffffff"
const FUTURE_TIME = "2100-01-01T12:00:00"
const PAST_TIME = "2000-01-01T12:00:00"
/** Reference "now" for statically evaluating requestTime guards:
 * FUTURE_TIME sorts after it, PAST_TIME before. */
const REFERENCE_NOW = "2026-01-01T12:00:00"

type GuardTree = Record<string, unknown>
type ComparisonOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte"

/** A statically readable constraint a guard puts on one row field. */
interface FieldConstraint {
  op: ComparisonOp
  kind: "const" | "requestTime"
  value?: unknown
}

function guardConstraints(guard: unknown, out = new Map<string, FieldConstraint[]>()): Map<string, FieldConstraint[]> {
  const g = guard as GuardTree | undefined
  if (g === undefined || typeof g !== "object") return out
  if (g.__expr === "and") {
    guardConstraints(g.left, out)
    guardConstraints(g.right, out)
  } else if (g.__expr === "cmp") {
    const left = g.left as GuardTree | undefined
    const right = g.right as GuardTree | undefined
    if (
      left?.__expr === "field" && typeof left.name === "string" &&
      (right?.__expr === "const" || right?.__expr === "requestTime")
    ) {
      const list = out.get(left.name) ?? []
      list.push({ op: g.op as ComparisonOp, kind: right.__expr, ...(right.__expr === "const" ? { value: right.value } : {}) })
      out.set(left.name, list)
    }
  }
  return out
}

function evalTerm(term: GuardTree | undefined, row: Record<string, unknown>): unknown | undefined {
  if (term?.__expr === "field") return row[term.name as string]
  if (term?.__expr === "const") return term.value
  if (term?.__expr === "requestTime") return REFERENCE_NOW
  return undefined
}

/** Tri-state guard evaluation: true/false when decidable, undefined when
 * the tree references anything the compiler cannot statically see. */
function evalGuard(guard: unknown, row: Record<string, unknown>): boolean | undefined {
  const g = guard as GuardTree | undefined
  if (g === undefined) return true
  if (g.__expr === "and") {
    const left = evalGuard(g.left, row)
    const right = evalGuard(g.right, row)
    if (left === false || right === false) return false
    if (left === undefined || right === undefined) return undefined
    return true
  }
  if (g.__expr === "cmp") {
    const left = evalTerm(g.left as GuardTree, row)
    const right = evalTerm(g.right as GuardTree, row)
    if (left === undefined || right === undefined) return undefined
    switch (g.op as ComparisonOp) {
      case "eq": return left === right
      case "neq": return left !== right
      case "lt": return (left as never) < (right as never)
      case "lte": return (left as never) <= (right as never)
      case "gt": return (left as never) > (right as never)
      case "gte": return (left as never) >= (right as never)
    }
  }
  return undefined
}

/** A value for `field` that satisfies one of its guard constraints, or
 * undefined when not derivable (or unsatisfiable under declared bounds). */
function directedValue(field: BlueprintField, constraints: FieldConstraint[]): unknown | undefined {
  for (const c of constraints) {
    if (c.kind === "requestTime" && field.type === "datetime") {
      if (c.op === "gt" || c.op === "gte") return FUTURE_TIME
      if (c.op === "lt" || c.op === "lte") return PAST_TIME
    }
    if (c.kind === "const" && field.type === "int" && typeof c.value === "number") {
      const v =
        c.op === "gt" ? c.value + 1 :
        c.op === "gte" ? c.value :
        c.op === "lt" ? c.value - 1 :
        c.op === "lte" ? c.value :
        c.op === "eq" ? c.value : c.value + 1
      if (field.min !== undefined && v < field.min) return undefined
      if (field.max !== undefined && v > field.max) return undefined
      return v
    }
    if (c.kind === "const" && field.type === "string" && typeof c.value === "string") {
      if (c.op === "eq") return c.value
      if (c.op === "neq") return `${c.value}-x`
    }
  }
  return undefined
}

/** The OPPOSITE of directedValue — a value that violates the guard. */
function violatingValue(field: BlueprintField, constraints: FieldConstraint[]): unknown | undefined {
  for (const c of constraints) {
    if (c.kind === "requestTime" && field.type === "datetime") {
      if (c.op === "gt" || c.op === "gte") return PAST_TIME
      if (c.op === "lt" || c.op === "lte") return FUTURE_TIME
    }
    if (c.kind === "const" && field.type === "int" && typeof c.value === "number") {
      const v =
        c.op === "gt" || c.op === "gte" ? c.value :
        c.op === "lt" || c.op === "lte" ? c.value + 1 :
        c.op === "eq" ? c.value + 1 : c.value
      if (field.min !== undefined && v < field.min) return undefined
      if (field.max !== undefined && v > field.max) return undefined
      return v
    }
    if (c.kind === "const" && field.type === "string" && typeof c.value === "string") {
      // The violating value must stay creatable: a value that would 422 on
      // maxLength never reaches the invariant, so it is not a probe.
      if (c.op === "neq" && (field.maxLength === undefined || c.value.length <= field.maxLength)) {
        return c.value
      }
      const eqViolating = c.value === "" ? undefined : `${c.value}-violating`
      if (c.op === "eq" && eqViolating !== undefined &&
          (field.maxLength === undefined || eqViolating.length <= field.maxLength)) {
        return eqViolating
      }
    }
  }
  return undefined
}

/** Deterministic sample data for one field (field-NAME-keyed world). */
function sampleData(field: BlueprintField, seq: () => number, constraints: FieldConstraint[] = [], invert = false): unknown {
  const directed = invert ? violatingValue(field, constraints) : directedValue(field, constraints)
  if (directed !== undefined) return directed
  switch (field.type) {
    case "string": {
      const base = field.unique ? `u${seq()}-${field.name}` : `sample-${field.name}`
      return field.maxLength !== undefined ? base.slice(0, field.maxLength) : base
    }
    case "email":
      return `u${seq()}@example.com`
    case "int": {
      let v = invert ? 7 : 42
      if (field.min !== undefined && v < field.min) v = field.min
      if (field.max !== undefined && v > field.max) v = field.max
      return v
    }
    case "boolean":
      return invert ? false : true
    case "datetime":
      return invert ? "2029-01-01T12:00:00" : "2030-01-01T12:00:00"
    case "enum": {
      const states = field.states ?? ["state"]
      return states[Math.min(invert ? 1 : 0, states.length - 1)]
    }
    default:
      return undefined
  }
}

interface SeedOptions {
  as: string
  overrides?: Record<string, unknown>
  guard?: unknown
  state?: string
  invertGuard?: boolean
}

/** Synthesize one fixture row and record it (column-keyed insert payload +
 * field-name-keyed value view). Returns the field-name view. */
function seedRow(
  bp: BackendBlueprint,
  entity: BlueprintEntity,
  given: Array<{ table: string; as: string; row: Record<string, unknown> }>,
  nextUuid: () => string,
  seq: () => number,
  options: SeedOptions,
): Record<string, unknown> {
  const lifecycle = bp.lifecycles.find((l) => l.entity === entity.name)
  const constraints =
    options.guard !== undefined ? guardConstraints(options.guard) : new Map<string, FieldConstraint[]>()
  const fields: Record<string, unknown> = {}
  for (const field of entity.fields) {
    if (field.name === "id") {
      fields.id = nextUuid()
      continue
    }
    const override = options.overrides?.[field.name]
    if (override !== undefined) {
      fields[field.name] = override
      continue
    }
    if (lifecycle?.field === field.name && options.state === undefined) {
      fields[field.name] = lifecycle.initial
      continue
    }
    if (lifecycle?.field === field.name) {
      fields[field.name] = options.state
      continue
    }
    if (field.type === "uuid" || field.type === "ref") {
      fields[field.name] = nextUuid()
      continue
    }
    fields[field.name] = sampleData(field, seq, constraints.get(field.name) ?? [], options.invertGuard === true)
  }
  if (fields.id === undefined) fields.id = nextUuid()
  // The auth principal's implicit password column is NOT NULL; direct
  // table inserts must carry a placeholder (the runner replaces the
  // auth block's hash at runtime; fixture rows need any legal string).
  if (bp.auth?.principal === entity.name && !fields[bp.auth.passwordColumn]) {
    fields[bp.auth.passwordColumn] = "placeholder-not-used"
  }
  const row: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(fields)) {
    const field = entity.fields.find((f) => f.name === name)
    row[field ? field.column : name] = value
  }
  // Explicit created_at: wall-clock defaults would stamp the auth
  // principal (seeded first) earlier than fixture rows, breaking list
  // probes' firstId. Fixtures get 2020, the principal gets 2019.
  if (row.created_at === undefined) row.created_at = "2020-01-01T00:00:00"
  given.push({ table: entity.table, as: options.as, row })
  return fields
}

interface BehaviorTriple {
  given: Array<{ table: string; as: string; row: Record<string, unknown> }>
  request: {
    method: string
    path: string
    pathAs?: string
    unknownPathId?: boolean
    body?: Record<string, unknown>
    auth?: boolean
    /** Seed the auth principal (known password) even without a token —
     * login/register probes address it directly. */
    needsPrincipal?: boolean
  }
  expect: {
    status: number
    body?: Record<string, unknown>
    exactKeys?: string[]
    /** list routes answer a bare array; assert its length + first row id. */
    list?: { length: number; firstId: unknown }
    state?: {
      counts?: Array<{ table: string; expected: number }>
      outbox?: Array<{ event: string; payload: Record<string, unknown> }>
    }
  }
  label?: string
}

/** Behavior triples for the auth node: register/login/me with the pinned
 * no-enumeration contract (wrong password and unknown identity answer the
 * IDENTICAL 401 body — both triples assert the same literal). */
function authRouterBehavior(bp: BackendBlueprint): Record<string, unknown> | undefined {
  const auth = bp.auth!
  const principal = bp.entities.find((e) => e.name === auth.principal)
  if (principal === undefined) return undefined
  let uuidN = 0
  let seqN = 0
  const nextUuid = () => {
    uuidN += 1
    return `00000000-0000-4000-8000-${String(uuidN).padStart(12, "0")}`
  }
  const seq = () => {
    seqN += 1
    return seqN
  }
  const authGiven: BehaviorTriple["given"] = []
  const principalView = seedRow(bp, principal, authGiven, nextUuid, seq, { as: "principal" })
  const knownIdentity = String(principalView[auth.identityField])
  const outKeys = principal.fields.map((f) => f.name).sort()
  const triples: BehaviorTriple[] = []

  const register = auth.routes.find((r) => r.operation === "register")
  if (register !== undefined) {
    const body: Record<string, unknown> = {}
    for (const field of principal.fields) {
      if (field.name === "id" || field.optional === true || field.default !== undefined) continue
      body[field.name] = sampleData(field, seq)
    }
    body.password = "secret123"
    triples.push({
      label: `register:${register.id}`,
      given: [],
      request: { method: register.method, path: register.path, body },
      expect: {
        status: register.status,
        exactKeys: outKeys,
        body: { [auth.identityField]: body[auth.identityField] },
      },
    })
    const duplicate = { ...body, [auth.identityField]: knownIdentity }
    triples.push({
      label: `register-duplicate:${register.id}`,
      given: [],
      request: { method: register.method, path: register.path, body: duplicate, needsPrincipal: true },
      expect: { status: 409, body: bp.contract.errors.alreadyExists.body },
    })
  }
  const login = auth.routes.find((r) => r.operation === "login")
  if (login !== undefined) {
    triples.push({
      label: `login:${login.id}`,
      given: [],
      request: {
        method: login.method,
        path: login.path,
        body: { [auth.identityField]: knownIdentity, password: "secret123" },
        needsPrincipal: true,
      },
      expect: {
        status: login.status,
        body: { access_token: { __expect: "notNull" }, token_type: "bearer" },
      },
    })
    triples.push({
      label: `login-wrong-password:${login.id}`,
      given: [],
      request: {
        method: login.method,
        path: login.path,
        body: { [auth.identityField]: knownIdentity, password: "totally-wrong-secret" },
        needsPrincipal: true,
      },
      expect: { status: 401, body: bp.contract.errors.invalidCredentials.body },
    })
    triples.push({
      label: `login-unknown-identity:${login.id}`,
      given: [],
      request: {
        method: login.method,
        path: login.path,
        body: { [auth.identityField]: "nobody-here@example.com", password: "secret123" },
      },
      expect: { status: 401, body: bp.contract.errors.invalidCredentials.body },
    })
  }
  const me = auth.routes.find((r) => r.operation === "me")
  if (me !== undefined) {
    triples.push({
      label: `me:${me.id}`,
      given: [],
      request: { method: me.method, path: me.path, auth: true },
      expect: { status: me.status, exactKeys: outKeys, body: { [auth.identityField]: knownIdentity } },
    })
    triples.push({
      label: `me-unauthenticated:${me.id}`,
      given: [],
      request: { method: me.method, path: me.path },
      expect: { status: 401, body: bp.contract.errors.unauthenticated.body },
    })
  }
  if (triples.length === 0) return undefined
  return {
    triples,
    auth: {
      table: principal.table,
      row: authGiven[0].row,
      passwordColumn: auth.passwordColumn,
      subject: String(principalView.id),
    },
  }
}

/** Compile the behavior block for one router node: rule-derived probes for
 * every route it owns plus the author examples targeting those routes. */
function routerBehavior(bp: BackendBlueprint, taskId: string): Record<string, unknown> | undefined {
  if (taskId === "router:auth" && bp.auth !== undefined) {
    return authRouterBehavior(bp)
  }
  const routes = bp.routes.filter((r) => r.owner.taskId === taskId && r.entity !== undefined)
  if (routes.length === 0) return undefined
  const entity = bp.entities.find((e) => e.name === routes[0].entity)
  if (entity === undefined) return undefined
  const lifecycle = bp.lifecycles.find((l) => l.entity === entity.name)
  const stateField = lifecycle?.field

  let uuidN = 0
  let seqN = 0
  const nextUuid = () => {
    uuidN += 1
    return `00000000-0000-4000-8000-${String(uuidN).padStart(12, "0")}`
  }
  const seq = () => {
    seqN += 1
    return seqN
  }

  const triples: BehaviorTriple[] = []
  const errors = bp.contract.errors
  const hasAuth = bp.auth !== undefined
  const principalTable = bp.auth !== undefined ? bp.entities.find((e) => e.name === bp.auth!.principal)?.table : undefined

  /** Expected absolute row count of `table` after a triple runs. */
  const expectedCount = (given: BehaviorTriple["given"], table: string, delta: number, withAuth: boolean): number =>
    given.filter((g) => g.table === table).length + (withAuth && principalTable === table ? 1 : 0) + delta

  /** Seed rows for every ref target of the entity, returning ref ids. */
  const seedRefTargets = (
    given: BehaviorTriple["given"],
    forEntity: BlueprintEntity,
  ): Record<string, string> => {
    const refs: Record<string, string> = {}
    for (const field of forEntity.fields) {
      if (field.type !== "ref" || field.target === undefined) continue
      const target = bp.entities.find((e) => e.name === field.target)
      if (target === undefined) continue
      const row = seedRow(bp, target, given, nextUuid, seq, { as: `${field.target.toLowerCase()}${given.length}` })
      refs[field.name] = String(row.id)
    }
    return refs
  }

  /** A synthesized create body: required fields only, refs seeded. */
  const createBody = (given: BehaviorTriple["given"], overrides: Record<string, unknown> = {}) => {
    const refs = seedRefTargets(given, entity)
    const body: Record<string, unknown> = {}
    for (const field of entity.fields) {
      if (field.name === "id" || field.name === stateField) continue
      if (field.type === "ref") {
        if (field.optional !== true) body[field.name] = refs[field.name]
        continue
      }
      if (field.optional === true || field.default !== undefined) continue
      body[field.name] = overrides[field.name] ?? sampleData(field, seq)
    }
    return body
  }

  /* ---- create probes ---- */
  const create = routes.find((r) => r.operation === "create")
  if (create !== undefined) {
    const given: BehaviorTriple["given"] = []
    const body = createBody(given)
    const echo: Record<string, unknown> = { ...body }
    if (stateField !== undefined) echo[stateField] = lifecycle!.initial
    triples.push({
      label: `create:${create.id}`,
      given,
      request: { method: create.method, path: create.path, body, auth: create.auth && hasAuth },
      expect: { status: create.status, body: echo },
    })
    const refField = entity.fields.find((f) => f.type === "ref" && f.optional !== true)
    if (refField !== undefined) {
      const danglingGiven: BehaviorTriple["given"] = []
      const dangling = createBody(danglingGiven)
      dangling[refField.name] = UNKNOWN_UUID
      triples.push({
        label: `create-dangling:${create.id}`,
        given: danglingGiven,
        request: { method: create.method, path: create.path, body: dangling, auth: create.auth && hasAuth },
        expect: { status: 404, body: errors.notFound.body },
      })
    }
    const uniqueField = entity.fields.find((f) => f.unique && f.type !== "ref" && f.optional !== true && f.name !== bp.auth?.identityField)
    if (uniqueField !== undefined && bp.auth?.principal !== entity.name) {
      const conflictGiven: BehaviorTriple["given"] = []
      const seeded = seedRow(bp, entity, conflictGiven, nextUuid, seq, { as: "existing" })
      const conflict = createBody(conflictGiven, { [uniqueField.name]: seeded[uniqueField.name] })
      triples.push({
        label: `create-conflict:${create.id}`,
        given: conflictGiven,
        request: { method: create.method, path: create.path, body: conflict, auth: create.auth && hasAuth },
        expect: { status: 409, body: errors.alreadyExists.body },
      })
    }
    const intField = entity.fields.find((f) => f.type === "int" && f.optional !== true && f.name !== stateField)
    if (intField !== undefined) {
      const badGiven: BehaviorTriple["given"] = []
      const bad = createBody(badGiven)
      bad[intField.name] = "not-an-int"
      triples.push({
        label: `create-invalid:${create.id}`,
        given: badGiven,
        request: { method: create.method, path: create.path, body: bad, auth: create.auth && hasAuth },
        expect: { status: 422 },
      })
    }
    for (const field of entity.fields) {
      const out = field.min !== undefined ? field.min - 1 : field.max !== undefined ? field.max + 1 : undefined
      if (out === undefined || field.name === stateField || field.optional === true) continue
      const boundGiven: BehaviorTriple["given"] = []
      const bound = createBody(boundGiven)
      bound[field.name] = field.maxLength !== undefined && field.type === "string"
        ? "x".repeat(field.maxLength + 1)
        : out
      triples.push({
        label: `create-bound:${field.name}`,
        given: boundGiven,
        request: { method: create.method, path: create.path, body: bound, auth: create.auth && hasAuth },
        expect: { status: 422 },
      })
    }
  }

  /* ---- read/update/delete/count probes ---- */
  const seedSubject = (given: BehaviorTriple["given"], as = "subject", state?: string) =>
    seedRow(bp, entity, given, nextUuid, seq, { as, ...(state !== undefined ? { state } : {}) })

  const readRoute = routes.find((r) => r.operation === "get")
  if (readRoute !== undefined) {
    const given: BehaviorTriple["given"] = []
    const subject = seedSubject(given)
    const probeField = entity.fields.find((f) => f.type !== "ref" && f.name !== "id" && f.name !== stateField)
    triples.push({
      label: `get:${readRoute.id}`,
      given,
      request: { method: readRoute.method, path: readRoute.path, pathAs: "subject", auth: readRoute.auth && hasAuth },
      expect: {
        status: readRoute.status,
        body: {
          id: subject.id,
          ...(probeField !== undefined ? { [probeField.name]: subject[probeField.name] } : {}),
        },
      },
    })
    triples.push({
      label: `get-unknown:${readRoute.id}`,
      given: [],
      request: { method: readRoute.method, path: readRoute.path, unknownPathId: true, auth: readRoute.auth && hasAuth },
      expect: { status: 404, body: errors.notFound.body },
    })
  }

  const listRoute = routes.find((r) => r.operation === "list")
  if (listRoute !== undefined) {
    const given: BehaviorTriple["given"] = []
    const first = seedSubject(given)
    const auth = listRoute.auth && hasAuth
    triples.push({
      label: `list:${listRoute.id}`,
      given,
      request: { method: listRoute.method, path: listRoute.path, auth },
      expect: {
        status: listRoute.status,
        list: { length: expectedCount(given, entity.table, 0, auth === true), firstId: first.id },
      },
    })
  }

  const updateRoute = routes.find((r) => r.operation === "update")
  if (updateRoute !== undefined) {
    const given: BehaviorTriple["given"] = []
    const subject = seedSubject(given)
    const patchField = entity.fields.find((f) => f.type !== "ref" && f.name !== "id" && f.name !== stateField && f.optional !== true)
    const body: Record<string, unknown> = {}
    let echo: Record<string, unknown> = { id: subject.id }
    if (patchField !== undefined) {
      const updated = sampleData(patchField, seq, [], true)
      body[patchField.name] = updated
      echo = { ...echo, [patchField.name]: updated }
    }
    triples.push({
      label: `update:${updateRoute.id}`,
      given,
      request: { method: updateRoute.method, path: updateRoute.path, pathAs: "subject", body, auth: updateRoute.auth && hasAuth },
      expect: { status: updateRoute.status, body: echo },
    })
    triples.push({
      label: `update-unknown:${updateRoute.id}`,
      given: [],
      request: { method: updateRoute.method, path: updateRoute.path, unknownPathId: true, body, auth: updateRoute.auth && hasAuth },
      expect: { status: 404, body: errors.notFound.body },
    })
  }

  const deleteRoute = routes.find((r) => r.operation === "delete")
  if (deleteRoute !== undefined) {
    const given: BehaviorTriple["given"] = []
    seedSubject(given)
    const auth = deleteRoute.auth && hasAuth
    triples.push({
      label: `delete:${deleteRoute.id}`,
      given,
      request: { method: deleteRoute.method, path: deleteRoute.path, pathAs: "subject", auth },
      expect: {
        status: deleteRoute.status,
        state: { counts: [{ table: entity.table, expected: expectedCount(given, entity.table, -1, auth === true) }] },
      },
    })
  }

  const countRoute = routes.find((r) => r.operation === "count")
  if (countRoute !== undefined) {
    const given: BehaviorTriple["given"] = []
    seedSubject(given)
    seedSubject(given, "subject2")
    const auth = countRoute.auth && hasAuth
    triples.push({
      label: `count:${countRoute.id}`,
      given,
      request: { method: countRoute.method, path: countRoute.path, auth },
      expect: {
        status: countRoute.status,
        body: { count: expectedCount(given, entity.table, 0, auth === true) },
      },
    })
  }

  /* ---- transition probes ---- */
  for (const route of routes.filter((r) => r.operation === "transition")) {
    const tr = route.transition!
    const happyGiven: BehaviorTriple["given"] = []
    const subject = seedRow(bp, entity, happyGiven, nextUuid, seq, {
      as: "subject",
      state: tr.from[0],
      guard: tr.guard,
    })
    if (evalGuard(tr.guard, subject) === true) {
      const body: Record<string, unknown> = { id: subject.id, [tr.field]: tr.to }
      const state: BehaviorTriple["expect"]["state"] = {}
      const simulated: Record<string, unknown> = { ...subject }
      for (const eff of tr.effects ?? []) {
        const e = eff as Record<string, unknown>
        if (e.__effect === "set") {
          const value = e.value as GuardTree | undefined
          simulated[String(e.field)] = value?.__expr === "const" ? value.value : simulated[String(e.field)]
          if (value?.__expr === "const") {
            body[String(e.field)] = value.value
          } else if (value?.__expr === "requestTime") {
            body[String(e.field)] = { __expect: "notNull" }
          }
        }
      }
      for (const eff of tr.effects ?? []) {
        const e = eff as Record<string, unknown>
        if (e.__effect !== "emit") continue
        const payload: Record<string, unknown> = {}
        for (const name of (e.fields as string[]) ?? []) {
          const value = simulated[name]
          payload[name] = value === undefined ? { __expect: "any" } : value
        }
        ;(state.outbox ??= []).push({ event: String(e.event), payload })
      }
      triples.push({
        label: `transition:${route.id}`,
        given: happyGiven,
        request: { method: route.method, path: route.path, pathAs: "subject", auth: route.auth && hasAuth },
        expect: {
          status: route.status,
          body,
          ...(state.outbox !== undefined || state.counts !== undefined ? { state } : {}),
        },
      })
    }
    const wrongStates = (entity.fields.find((f) => f.name === tr.field)?.states ?? []).filter(
      (s) => !tr.from.includes(s),
    )
    if (wrongStates.length > 0) {
      const given: BehaviorTriple["given"] = []
      seedRow(bp, entity, given, nextUuid, seq, { as: "subject", state: wrongStates[0] })
      triples.push({
        label: `transition-wrong-state:${route.id}`,
        given,
        request: { method: route.method, path: route.path, pathAs: "subject", auth: route.auth && hasAuth },
        expect: { status: 409, body: errors.guardFailed.body },
      })
    }
    if (tr.guard !== undefined) {
      const failGiven: BehaviorTriple["given"] = []
      const failView = seedRow(bp, entity, failGiven, nextUuid, seq, {
        as: "subject",
        state: tr.from[0],
        guard: tr.guard,
        invertGuard: true,
      })
      // Only emit when the inverted world provably violates the guard.
      if (evalGuard(tr.guard, failView) === false) {
        triples.push({
          label: `transition-guard:${route.id}`,
          given: failGiven,
          request: { method: route.method, path: route.path, pathAs: "subject", auth: route.auth && hasAuth },
          expect: { status: 409, body: errors.guardFailed.body },
        })
      }
    }
    triples.push({
      label: `transition-unknown:${route.id}`,
      given: [],
      request: { method: route.method, path: route.path, unknownPathId: true, auth: route.auth && hasAuth },
      expect: { status: 404, body: errors.notFound.body },
    })
  }

  /* ---- invariant probes: direct-seeded minimally violating worlds ---- */
  const invariantIds = [...new Set(routes.flatMap((r) => r.invariantIds ?? []))].sort()
  for (const invariantId of invariantIds) {
    const inv = bp.invariants.find((i) => i.id === invariantId)
    if (inv === undefined) continue
    if (inv.shape === "rowCheck") {
      // Single-row check tree: create with a derivable violating value.
      const constraints = guardConstraints(inv.check)
      const create = routes.find((r) => r.operation === "create")
      if (create === undefined) continue
      for (const [fieldName, list] of [...constraints.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const field = entity.fields.find((f) => f.name === fieldName)
        if (field === undefined || field.optional === true) continue
        const bad = violatingValue(field, list)
        if (bad === undefined) continue
        const given: BehaviorTriple["given"] = []
        const body = createBody(given)
        body[fieldName] = bad
        triples.push({
          label: `invariant:${inv.name}`,
          given,
          request: { method: create.method, path: create.path, body, auth: create.auth && hasAuth },
          expect: {
            status: 409,
            body: errors.invariantViolated.body,
            state: { counts: [{ table: entity.table, expected: expectedCount(given, entity.table, 0, create.auth && hasAuth) }] },
          },
        })
        break
      }
    }
    if (inv.shape === "crossRowCount" && inv.count !== undefined) {
      const count = inv.count
      const parent = bp.entities.find((e) => e.name === inv.entity)
      const counted = bp.entities.find((e) => e.name === count.entity)
      if (parent === undefined || counted === undefined) continue
      const boundField =
        count.bound.kind === "field"
          ? parent.fields.find((f) => f.name === (count.bound as { name: string }).name)
          : undefined
      const baseBound =
        count.bound.kind === "const" ? Number(count.bound.value) : Math.max(boundField?.min ?? 0, 0)
      if (!Number.isInteger(baseBound) || baseBound < 0) continue
      if (entity.name === count.entity) {
        // Counted router: fill the parent to its bound with direct inserts,
        // then one more API create must answer 409.
        const create = routes.find((r) => r.operation === "create")
        if (create === undefined) continue
        const given: BehaviorTriple["given"] = []
        const parentRow = seedRow(bp, parent, given, nextUuid, seq, {
          as: "parent",
          ...(boundField !== undefined ? { overrides: { [boundField.name]: baseBound } } : {}),
        })
        for (let i = 0; i < baseBound; i += 1) {
          seedRow(bp, entity, given, nextUuid, seq, {
            as: `fill${i}`,
            overrides: { [count.refField]: parentRow.id },
          })
        }
        const body = createBody(given)
        body[count.refField] = parentRow.id
        triples.push({
          label: `invariant:${inv.name}`,
          given,
          request: { method: create.method, path: create.path, body, auth: create.auth && hasAuth },
          expect: { status: 409, body: errors.invariantViolated.body },
        })
      } else if (entity.name === inv.entity && boundField !== undefined) {
        // Bound router: tightening the bound below the live child count
        // answers 409 (skipped when the tightened value would 422 first).
        const update = routes.find((r) => r.operation === "update")
        const tightened = baseBound - 1
        if (update === undefined || tightened < (boundField.min ?? 0)) continue
        const given: BehaviorTriple["given"] = []
        const parentRow = seedRow(bp, parent, given, nextUuid, seq, {
          as: "self",
          overrides: { [boundField.name]: baseBound },
        })
        for (let i = 0; i < baseBound; i += 1) {
          seedRow(bp, counted, given, nextUuid, seq, {
            as: `fill${i}`,
            overrides: { [count.refField]: parentRow.id },
          })
        }
        triples.push({
          label: `invariant-tighten:${inv.name}`,
          given,
          request: {
            method: update.method,
            path: update.path,
            pathAs: "self",
            body: { [boundField.name]: tightened },
            auth: update.auth && hasAuth,
          },
          expect: { status: 409, body: errors.invariantViolated.body },
        })
      }
    }
  }

  /* ---- auth probe: a protected GET without a token answers 401 ---- */
  const protectedGet = routes.find((r) => r.auth && (r.operation === "list" || r.operation === "get" || r.operation === "count"))
  if (protectedGet !== undefined && hasAuth) {
    triples.push({
      label: `unauthenticated:${protectedGet.id}`,
      given: [],
      request: { method: protectedGet.method, path: protectedGet.path },
      expect: { status: 401, body: errors.unauthenticated.body },
    })
  }

  /* ---- author examples targeting this node's routes ---- */
  for (const example of bp.examples) {
    const route = bp.routes.find((r) => r.id === example.routeId)
    if (route === undefined || route.owner.taskId !== taskId) continue
    const given: BehaviorTriple["given"] = []
    const rowsByAs = new Map<string, Record<string, unknown>>()
    const resolve = (value: unknown): unknown =>
      typeof value === "string" && value.startsWith("$") ? String(rowsByAs.get(value.slice(1))?.id) : value
    for (const fixture of example.given) {
      const target = bp.entities.find((e) => e.name === fixture.entity)
      if (target === undefined) continue
      const overrides: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(fixture.fields ?? {})) {
        overrides[name] = resolve(value)
      }
      const view = seedRow(bp, target, given, nextUuid, seq, { as: fixture.as, overrides })
      rowsByAs.set(fixture.as, view)
    }
    const body = example.input !== undefined
      ? Object.fromEntries(Object.entries(example.input).map(([k, v]) => [k, resolve(v)]))
      : undefined
    const state: BehaviorTriple["expect"]["state"] = {}
    const auth = route.auth && hasAuth
    for (const count of example.expect.state?.counts ?? []) {
      const table = bp.entities.find((e) => e.name === count.entity)?.table
      if (table !== undefined) {
        const seeded = given.filter((g) => g.table === table).length
        ;(state.counts ??= []).push({
          table,
          expected: seeded + (auth === true && principalTable === table ? 1 : 0) + count.delta,
        })
      }
    }
    for (const outbox of example.expect.state?.outbox ?? []) {
      const source = rowsByAs.get(outbox.fromAs)
      const payload: Record<string, unknown> = {}
      for (const name of outbox.fields) payload[name] = source?.[name] ?? { __expect: "any" }
      ;(state.outbox ??= []).push({ event: outbox.event, payload })
    }
    triples.push({
      label: `example:${example.name}`,
      given,
      request: {
        method: route.method,
        path: route.path,
        ...(example.subjectAs !== undefined ? { pathAs: example.subjectAs } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(auth ? { auth: true } : {}),
      },
      expect: {
        status: example.expect.status,
        ...(example.expect.body !== undefined ? { body: example.expect.body } : {}),
        ...(example.expect.match === "exact" && route.entity !== undefined
          ? { exactKeys: (bp.entities.find((e) => e.name === route.entity)?.fields ?? []).map((f) => f.name).sort() }
          : {}),
        ...(state.counts !== undefined || state.outbox !== undefined ? { state } : {}),
      },
    })
  }

  if (triples.length === 0) return undefined

  let authBlock: Record<string, unknown> | undefined
  if (hasAuth && principalTable !== undefined && bp.auth !== undefined) {
    const principal = bp.entities.find((e) => e.name === bp.auth!.principal)!
    const authGiven: BehaviorTriple["given"] = []
    const view = seedRow(bp, principal, authGiven, nextUuid, seq, { as: "principal" })
    if (authGiven[0] !== undefined && authGiven[0].row.created_at === undefined) {
      authGiven[0].row.created_at = "2019-01-01T00:00:00"
    }
    authBlock = {
      table: principalTable,
      row: authGiven[0].row,
      passwordColumn: bp.auth.passwordColumn,
      subject: String(view.id),
    }
  }

  return { triples, ...(authBlock !== undefined ? { auth: authBlock } : {}) }
}

/** The node's oracle contract: the machine-checkable slice of its clause table. */
function oracleContractFor(bp: BackendBlueprint, task: DagTask): Record<string, unknown> {
  const clauses = task.clauses.map((clause) => ({ id: clause.id, kind: clause.kind, verification: clause.verification, level: clause.level }))
  const base = { node: task.id, kind: task.kind, clauses }
  switch (task.kind) {
    case "project":
      return {
        ...base,
        pins: {
          name: bp.app.name.toLowerCase(),
          version: bp.app.version,
          requiresPython: `==${bp.stack.python}.*`,
          dependencies: Object.entries(bp.stack.dependencies).map(([name, version]) => `${name}==${version}`).sort(),
          dev: Object.entries(bp.stack.dev).map(([name, version]) => `${name}==${version}`).sort(),
        },
        files: ["app/__init__.py", ".gitignore"],
      }
    case "models": {
      const declared = (entityName: string, column: string): boolean =>
        bp.entities.find((e) => e.name === entityName)?.fields.some((f) => f.column === column) ?? false
      return {
        ...base,
        tables: [...bp.entities.map((e) => e.table), ...(bp.effects ? [bp.effects.eventsTable] : [])].sort(),
        entities: bp.entities.map((entity) => ({
          table: entity.table,
          columns: [
            ...entity.fields.map((f) => f.column),
            ...(!declared(entity.name, "id") ? ["id"] : []),
            ...(!declared(entity.name, "created_at") ? ["created_at"] : []),
            ...(bp.auth?.principal === entity.name && !declared(entity.name, bp.auth.passwordColumn) ? [bp.auth.passwordColumn] : []),
          ].sort(),
        })),
      }
    }
    case "database":
      return {
        ...base,
        exports: ["Base", "normalize_database_url", "resolve_database_url", "create_engine_from_url", "create_session_factory", "engine", "SessionLocal", "get_db", "session_dependency"],
        normalizeCases: normalizeCaseTable(bp),
      }
    case "schemas":
      return {
        ...base,
        entities: bp.entities.map((entity) => {
          const lifecycleField = bp.lifecycles.find((l) => l.entity === entity.name)?.field
          return {
            name: entity.name,
            createFields: entity.fields.filter((f) => f.name !== lifecycleField).map((f) => f.name).sort(),
            responseFields: entity.fields.map((f) => f.name).sort(),
            bounds: entity.fields
              .filter((f) => f.min !== undefined || f.max !== undefined || f.maxLength !== undefined)
              .map((f) => ({
                field: f.name,
                ...(f.min !== undefined ? { ge: f.min } : {}),
                ...(f.max !== undefined ? { le: f.max } : {}),
                ...(f.maxLength !== undefined ? { maxLength: f.maxLength } : {}),
              }))
              .sort((left, right) => left.field.localeCompare(right.field)),
          }
        }),
      }
    case "security":
      return { ...base, exports: ["hash_password", "verify_password", "create_access_token", "decode_access_token"] }
    case "router": {
      const routes: BlueprintRoute[] = bp.routes.filter((r) => r.owner.taskId === task.id)
      const countRoute = routes.find((r) => r.operation === "count")
      const hasIdRoute = routes.some((r) => r.path.includes("{id}"))
      const behavior = routerBehavior(bp, task.id)
      return {
        ...base,
        module: task.id === "router:auth" ? "app.routers.auth" : `app.routers.${task.id.slice("router:".length).toLowerCase()}`,
        routes: routes.map((r) => [r.method, r.path, r.status]).sort(([leftMethod, leftPath], [rightMethod, rightPath]) => `${leftMethod} ${leftPath}`.localeCompare(`${rightMethod} ${rightPath}`)),
        ...(countRoute && hasIdRoute ? { countBeforeId: true, countPath: countRoute.path } : {}),
        ...(behavior !== undefined ? { behavior } : {}),
      }
    }
    case "cache":
      return {
        ...base,
        exports: ["CacheUnavailable", "CachePolicy", "CACHE_POLICIES", "InMemoryCacheBackend", "RedisCacheBackend"],
        policies: bp.caches.map((c) => c.name).sort(),
        unknownPolicy: `${bp.caches[0]?.name ?? "cache"}-unknown`,
        behavior: {
          declarations: bp.caches.map((c) => ({
            name: c.name,
            providerKind: c.provider.kind,
            keyPrefix: c.keyPrefix,
            ttlSeconds: c.ttlSeconds,
            failureMode: c.failureMode,
            stampedeProtection: c.stampedeProtection,
          })),
        },
      }
    case "messaging":
      return {
        ...base,
        exports: ["MessageValidationError", "MESSAGE_DEFINITIONS", "QUEUE_POLICIES", "validate_payload", "build_envelope", "InMemoryMessageBroker"],
        definitions: bp.messages.map((m) => m.name).sort(),
        queues: bp.queues.map((q) => q.name).sort(),
        behavior: {
          messages: bp.messages.map((m) => ({ name: m.name, fields: m.fields })),
          declarations: bp.queues.map((q) => ({
            name: q.name,
            providerKind: q.provider.kind,
            messages: q.messages,
            delivery: q.delivery,
            ...(q.orderingKey !== undefined ? { orderingKey: q.orderingKey } : {}),
          })),
        },
      }
    case "blob":
      return {
        ...base,
        exports: ["BlobValidationError", "BlobPolicy", "BLOB_POLICIES", "normalize_blob_key", "InMemoryBlobStore", "S3BlobStore"],
        policies: bp.blobs.map((b) => b.name).sort(),
        behavior: {
          declarations: bp.blobs.map((b) => ({
            name: b.name,
            providerKind: b.provider.kind,
            bucket: b.bucket,
            keyPrefix: b.keyPrefix,
            maxBytes: b.maxBytes,
            contentTypes: b.contentTypes,
            signedUrlTtlSeconds: b.signedUrlTtlSeconds,
          })),
        },
      }
    case "app": {
      // Snapshot-invariant skeleton contract: the assertions hold with zero
      // routers present (app-node time) AND on the finished repository
      // (CI re-runs) — the registry includes exactly the existing pinned
      // candidates and the exposed interface is exactly their union.
      const candidates = [...new Set(bp.routes.filter((r) => r.entity !== undefined || r.operation === "login" || r.operation === "register" || r.operation === "me").map((r) => r.owner.taskId))]
        .map((taskId) => `app.routers.${taskId.slice("router:".length).toLowerCase()}`)
        .sort()
      return {
        ...base,
        title: bp.app.title,
        version: bp.app.version,
        routes: [] as string[],
        registryCandidates: candidates,
      }
    }
    default:
      return base
  }
}

function pythonString(value: string): string {
  return JSON.stringify(value)
}

/** The frozen generic runner shared by every node oracle in one module. */
function runnerSource(): string {
  return `"""Compiler-owned node oracle runner — DO NOT EDIT.

Generated by @spec/fastapi alongside the per-node CONTRACT test files.
It mechanically verifies the oracle-verifiable clauses of one node:
import surfaces, route tables, table metadata, pins, schema field sets,
pure module behaviors, and the assembled application's OpenAPI interface.
Deep behavioral judgment lives in the conformance suite, never here.
"""
import importlib
import inspect
import json
import sys
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[2]
if str(MODULE_ROOT) not in sys.path:
    sys.path.insert(0, str(MODULE_ROOT))


def check_contract(contract):
    dispatch = {
        "project": _check_project,
        "models": _check_models,
        "database": _check_database,
        "schemas": _check_schemas,
        "security": _check_security,
        "router": _check_router,
        "cache": _check_cache,
        "messaging": _check_messaging,
        "blob": _check_blob,
        "app": _check_app,
    }
    handler = dispatch.get(contract["kind"])
    assert handler is not None, f"unknown oracle kind {contract['kind']}"
    handler(contract)


def _import(name):
    return importlib.import_module(name)


def _check_project(contract):
    import tomllib

    pins = contract["pins"]
    data = tomllib.loads((MODULE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    project = data["project"]
    assert project["name"] == pins["name"], project["name"]
    assert project["version"] == pins["version"], project["version"]
    assert project["requires-python"] == pins["requiresPython"], project["requires-python"]
    assert sorted(project["dependencies"]) == sorted(pins["dependencies"]), project["dependencies"]
    dev = project.get("optional-dependencies", {}).get("dev", [])
    assert sorted(dev) == sorted(pins["dev"]), dev
    for relative in contract["files"]:
        assert (MODULE_ROOT / relative).exists(), relative


def _check_models(contract):
    models = _import("app.models")
    tables = set(models.Base.metadata.tables)
    expected = set(contract["tables"])
    assert tables == expected, (sorted(tables), sorted(expected))
    for entity in contract["entities"]:
        table = models.Base.metadata.tables[entity["table"]]
        columns = set(table.columns.keys())
        assert columns == set(entity["columns"]), (entity["table"], sorted(columns))


def _check_database(contract):
    database = _import("app.database")
    for name in contract["exports"]:
        assert hasattr(database, name), name
    for value, expected in contract["normalizeCases"]:
        assert database.normalize_database_url(value) == expected, (value, expected)
    engine = database.create_engine_from_url("sqlite://")
    assert engine.dialect.name == "sqlite"
    # session_dependency(factory) must RETURN a callable dependency — a
    # generator function here silently breaks every get_db override.
    factory = database.create_session_factory(engine)
    dependency = database.session_dependency(factory)
    assert callable(dependency), (
        "session_dependency(factory) returned a non-callable (generator?): "
        "it must RETURN a yielding dependency closure, not BE one"
    )
    engine.dispose()


def _check_schemas(contract):
    from pydantic import BaseModel

    schemas = _import("app.schemas")
    for entity in contract["entities"]:
        for suffix in ("Create", "Update", "Out"):
            model = getattr(schemas, entity["name"] + suffix, None)
            assert model is not None, entity["name"] + suffix
            assert issubclass(model, BaseModel), entity["name"] + suffix
        create = set(getattr(schemas, entity["name"] + "Create").model_fields)
        assert create == set(entity["createFields"]), (entity["name"], sorted(create))
        update = getattr(schemas, entity["name"] + "Update")
        for info in update.model_fields.values():
            assert not info.is_required(), (entity["name"] + "Update", info)
        out = set(getattr(schemas, entity["name"] + "Out").model_fields)
        assert out == set(entity["responseFields"]), (entity["name"], sorted(out))
        for bound in entity.get("bounds", []):
            for suffix in ("Create", "Update"):
                info = getattr(schemas, entity["name"] + suffix).model_fields[bound["field"]]
                for key, attr in (("ge", "ge"), ("le", "le"), ("maxLength", "max_length")):
                    if bound.get(key) is not None:
                        assert any(
                            getattr(m, attr, None) == bound[key] for m in info.metadata
                        ), (entity["name"], suffix, bound["field"], key, info.metadata)


def _check_security(contract):
    security = _import("app.security")
    for name in contract["exports"]:
        assert hasattr(security, name), name
    assert security.verify_password("secret", None) is False
    hashed = security.hash_password("secret")
    assert hashed.startswith("$2"), hashed[:4]
    assert security.verify_password("secret", hashed) is True


def _check_router(contract):
    from fastapi import APIRouter

    module = _import(contract["module"])
    router = getattr(module, "router", None)
    assert isinstance(router, APIRouter), contract["module"]
    actual = sorted(
        (method, route.path, route.status_code)
        for route in router.routes
        if getattr(route, "methods", None)
        for method in route.methods
        if method != "HEAD"
    )
    expected = sorted(
        (method, path, status)
        for method, path, status in contract["routes"]
    )
    assert actual == expected, (actual, expected)
    if contract.get("countBeforeId"):
        paths = [route.path for route in router.routes]
        count_index = paths.index(contract["countPath"])
        id_index = next(index for index, value in enumerate(paths) if "{id}" in value)
        assert count_index < id_index, (contract["countPath"], paths)
    source = inspect.getsource(module)
    assert "DeclarativeBase" not in source, "routers must not define or import an ORM base"
    for line in source.splitlines():
        stripped = line.strip()
        if stripped.startswith("from app.models import"):
            imported = stripped.split("import", 1)[1]
            assert "Base" not in [part.strip() for part in imported.split(",")], stripped
    if contract.get("behavior") is not None:
        _check_router_behavior(module, router, contract["behavior"])


def _check_router_behavior(module, router, behavior):
    """Oracle v2: run the compiled {given, request, expect} triples against
    a throwaway app — only this router, in-memory SQLite, a fresh world per
    triple. Fixtures are seeded by direct table inserts; the request is real
    HTTP; expectations are the compiler's literals."""
    import datetime as dt
    import uuid as uuid_module

    import sqlalchemy as sa
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app import database as database_module
    from app import models as models_module

    def coerce(table, row):
        out = {}
        for name, value in row.items():
            column = table.columns.get(name)
            if column is not None and getattr(column.type, "python_type", None) is dt.datetime:
                out[name] = dt.datetime.fromisoformat(value)
            elif column is not None and getattr(column.type, "python_type", None) is uuid_module.UUID:
                out[name] = uuid_module.UUID(str(value))
            else:
                out[name] = value
        return out

    def insert(engine, table_name, row):
        table = models_module.Base.metadata.tables[table_name]
        with engine.begin() as connection:
            connection.execute(table.insert(), [coerce(table, row)])

    for index, triple in enumerate(behavior["triples"]):
        label = triple.get("label") or f"#{index}"
        engine = database_module.create_engine_from_url("sqlite://")
        models_module.Base.metadata.create_all(engine)
        rows = {}
        token = None
        request = triple["request"]
        wants_auth = bool(request.get("auth"))
        if behavior.get("auth") is not None and (wants_auth or request.get("needsPrincipal")):
            from app import security as security_module

            auth = behavior["auth"]
            values = dict(auth["row"])
            values[auth["passwordColumn"]] = security_module.hash_password("secret123")
            insert(engine, auth["table"], values)
            token = security_module.create_access_token(auth["subject"])
        for seeded in triple.get("given", []):
            insert(engine, seeded["table"], seeded["row"])
            rows[seeded["as"]] = seeded["row"]

        application = FastAPI()
        application.include_router(router)
        factory = database_module.create_session_factory(engine)
        application.dependency_overrides[database_module.get_db] = database_module.session_dependency(factory)
        client = TestClient(application)

        path = request["path"]
        if request.get("unknownPathId"):
            path = path.replace("{id}", "ffffffff-ffff-4fff-8fff-ffffffffffff")
        elif request.get("pathAs"):
            path = path.replace("{id}", str(rows[request["pathAs"]]["id"]))
        kwargs = {}
        if request.get("body") is not None:
            kwargs["json"] = request["body"]
        if wants_auth and token is not None:
            kwargs["headers"] = {"Authorization": f"Bearer {token}"}
        response = getattr(client, request["method"].lower())(path, **kwargs)

        expect = triple["expect"]
        assert response.status_code == expect["status"], (
            label,
            request["method"],
            path,
            response.status_code,
            response.text,
        )
        if expect.get("body") is not None or expect.get("exactKeys") is not None or expect.get("list") is not None:
            payload = response.json()
            if expect.get("list") is not None:
                wanted = expect["list"]
                assert isinstance(payload, list), (label, type(payload))
                assert len(payload) == wanted["length"], (label, len(payload), wanted["length"])
                assert payload[0]["id"] == wanted["firstId"], (label, payload[0].get("id"))
            else:
                if expect.get("exactKeys") is not None:
                    assert set(payload.keys()) == set(expect["exactKeys"]), (label, sorted(payload.keys()))
                for key, value in (expect.get("body") or {}).items():
                    if isinstance(value, dict) and value.get("__expect") == "notNull":
                        assert payload.get(key) is not None, (label, key)
                    elif isinstance(value, dict) and value.get("__expect") == "any":
                        assert key in payload, (label, key)
                    elif isinstance(value, str) and value.startswith("$"):
                        assert payload[key] == rows[value[1:]]["id"], (label, key)
                    else:
                        assert payload.get(key) == value, (label, key, payload.get(key))
        state = expect.get("state") or {}
        if state.get("counts"):
            with engine.begin() as connection:
                for count in state["counts"]:
                    table = models_module.Base.metadata.tables[count["table"]]
                    actual = connection.execute(sa.select(sa.func.count()).select_from(table)).scalar_one()
                    assert actual == count["expected"], (label, count["table"], actual, count["expected"])
        for outbox in state.get("outbox") or []:
            events = models_module.Base.metadata.tables.get("events")
            assert events is not None, "emit effects require the events table"
            with engine.begin() as connection:
                found = connection.execute(
                    sa.select(events.c.event, events.c.payload).where(events.c.event == outbox["event"])
                ).fetchall()
            assert len(found) >= 1, (label, outbox["event"])
            payload = json.loads(found[-1][1])
            assert set(payload.keys()) == set(outbox["payload"].keys()), (label, sorted(payload.keys()))
            for key, value in outbox["payload"].items():
                if isinstance(value, dict) and value.get("__expect") == "any":
                    assert key in payload, (label, key)
                else:
                    assert payload.get(key) == value, (label, key, payload.get(key))
        engine.dispose()


def _run(coro):
    import asyncio

    return asyncio.run(coro)


def _check_cache(contract):
    cache = _import("app.cache")
    for name in contract["exports"]:
        assert hasattr(cache, name), name
    assert set(cache.CACHE_POLICIES) == set(contract["policies"]), sorted(map(str, cache.CACHE_POLICIES))
    backend = cache.InMemoryCacheBackend()

    async def unknown_policy():
        try:
            await backend.get(contract["unknownPolicy"], "k")
            return False
        except KeyError:
            return True

    assert _run(unknown_policy()), "unknown policy must raise KeyError"
    if contract.get("behavior") is not None:
        _check_cache_behavior(cache, contract["behavior"])


def _check_cache_behavior(module, behavior):
    """Oracle v2: the fake-client probes the terminal suite runs — in-memory
    semantics (isolation from caller mutation, single-flight loader), the
    exact redis call shapes, and the declared failure modes."""
    import pytest

    async def probe():
        backend = module.InMemoryCacheBackend()
        for policy in behavior["declarations"]:
            name = policy["name"]
            assert await backend.get(name, "asset:1") is None
            original = {"nested": [1, 2]}
            await backend.set(name, "asset:1", original)
            original["nested"].append(3)
            first = await backend.get(name, "asset:1")
            assert first == {"nested": [1, 2]}
            first["nested"].append(4)
            assert await backend.get(name, "asset:1") == {"nested": [1, 2]}
            await backend.delete(name, "asset:1")
            assert await backend.get(name, "asset:1") is None
            calls = 0

            async def loader():
                nonlocal calls
                calls += 1
                return {"loaded": True}

            assert await backend.get_or_set(name, "asset:2", loader) == {"loaded": True}
            assert await backend.get_or_set(name, "asset:2", loader) == {"loaded": True}
            assert calls == 1

    _run(probe())

    class FakeRedisClient:
        def __init__(self, *, fail=False):
            self.fail = fail
            self.values = {}
            self.calls = []

        def _check(self):
            if self.fail:
                raise OSError("provider unavailable")

        async def get(self, key):
            self.calls.append(("get", key))
            self._check()
            value = self.values.get(key)
            return value.encode("utf-8") if value is not None else None

        async def set(self, key, value, *, ex):
            self.calls.append(("set", key, value, ex))
            self._check()
            self.values[key] = value
            return True

        async def delete(self, key):
            self.calls.append(("delete", key))
            self._check()
            return 1 if self.values.pop(key, None) is not None else 0

    async def probe_redis():
        for policy in behavior["declarations"]:
            name = policy["name"]
            full_key = f'{policy["keyPrefix"]}:provider'
            client = FakeRedisClient()
            backend = module.RedisCacheBackend(client)
            value = {"nested": [1, 2]}
            await backend.set(name, "provider", value)
            assert client.calls[-1][0:2] == ("set", full_key)
            assert client.calls[-1][3] == policy["ttlSeconds"]
            assert json.loads(client.calls[-1][2]) == value
            assert await backend.get(name, "provider") == value
            await backend.delete(name, "provider")
            assert client.calls[-1] == ("delete", full_key)

        bypass = next((item for item in behavior["declarations"] if item["failureMode"] == "bypass"), None)
        if bypass is not None:
            bypass_backend = module.RedisCacheBackend(FakeRedisClient(fail=True))
            assert await bypass_backend.get(bypass["name"], "provider") is None
            await bypass_backend.set(bypass["name"], "provider", {"ok": True})
            await bypass_backend.delete(bypass["name"], "provider")

        closed = next((item for item in behavior["declarations"] if item["failureMode"] == "fail-closed"), None)
        if closed is not None:
            closed_backend = module.RedisCacheBackend(FakeRedisClient(fail=True))
            with pytest.raises(module.CacheUnavailable) as raised:
                await closed_backend.get(closed["name"], "provider")
            assert isinstance(raised.value.__cause__, OSError)

    _run(probe_redis())


def _check_messaging(contract):
    messaging = _import("app.messaging")
    for name in contract["exports"]:
        assert hasattr(messaging, name), name
    assert set(messaging.MESSAGE_DEFINITIONS) == set(contract["definitions"])
    assert set(messaging.QUEUE_POLICIES) == set(contract["queues"])
    known = sorted(messaging.MESSAGE_DEFINITIONS)[0]
    try:
        messaging.validate_payload(known, {})
        raise AssertionError("validate_payload must reject an empty payload")
    except messaging.MessageValidationError:
        pass
    if contract.get("behavior") is not None:
        _check_messaging_behavior(messaging, contract["behavior"])


def _sample_message_payload(message):
    by_kind = {
        "string": "sample",
        "int": 1,
        "boolean": True,
        "uuid": "00000000-0000-4000-8000-000000000030",
        "datetime": "2026-01-01T00:00:00",
    }
    return {name: by_kind[kind] for name, kind in message["fields"].items()}


def _check_messaging_behavior(module, behavior):
    """Oracle v2: envelope building, in-memory broker semantics (allowlists,
    dedup by delivery mode, drain order), and the exact provider call
    shapes for every declared queue — same probes the terminal suite runs."""
    from datetime import datetime

    import pytest

    messages = {item["name"]: item for item in behavior["messages"]}

    async def probe():
        broker = module.InMemoryMessageBroker()
        for queue in behavior["declarations"]:
            message = messages[queue["messages"][0]]
            payload = _sample_message_payload(message)
            module.validate_payload(message["name"], payload)
            with pytest.raises(module.MessageValidationError):
                module.validate_payload(message["name"], {})
            envelope = module.build_envelope(
                message["name"], payload,
                message_id="00000000-0000-4000-8000-000000000010",
                occurred_at=datetime(2026, 1, 1, 0, 0, 0),
            )
            assert envelope.message == message["name"]
            assert envelope.version == 1
            await broker.publish(queue["name"], envelope)
            await broker.publish(queue["name"], envelope)
            drained = await broker.drain(queue["name"])
            expected = 1 if queue["delivery"] == "at-least-once" else 2
            assert len(drained) == expected
            assert [item.id for item in drained] == [envelope.id] * expected

    _run(probe())

    class FakeKafkaClient:
        def __init__(self):
            self.calls = []

        async def send_and_wait(self, *args, **kwargs):
            self.calls.append((args, kwargs))

    class FakeRabbitClient:
        def __init__(self):
            self.calls = []

        async def publish(self, *args, **kwargs):
            self.calls.append((args, kwargs))

    class FakeSQSClient:
        def __init__(self):
            self.calls = []

        def send_message(self, **kwargs):
            self.calls.append(kwargs)
            return {"MessageId": "provider-message-id"}

    class_names = {"kafka": "KafkaBroker", "rabbitmq": "RabbitMQBroker", "sqs": "SQSBroker"}
    fakes = {"kafka": FakeKafkaClient, "rabbitmq": FakeRabbitClient, "sqs": FakeSQSClient}

    async def probe_providers():
        for queue in behavior["declarations"]:
            kind = queue["providerKind"]
            broker_class = getattr(module, class_names[kind], None)
            assert broker_class is not None, class_names[kind]
            client = fakes[kind]()
            broker = broker_class(client)
            message = messages[queue["messages"][0]]
            payload = _sample_message_payload(message)
            envelope = module.build_envelope(
                message["name"], payload,
                message_id="00000000-0000-4000-8000-000000000020",
                occurred_at=datetime(2026, 1, 1, 0, 0, 0),
            )
            expected_object = {
                "message": message["name"],
                "version": 1,
                "id": "00000000-0000-4000-8000-000000000020",
                "occurred_at": "2026-01-01T00:00:00",
                "payload": payload,
            }
            expected_text = json.dumps(expected_object, sort_keys=True, separators=(",", ":"))
            ordering = str(payload[queue["orderingKey"]]) if queue.get("orderingKey") else envelope.id
            await broker.publish(queue["name"], envelope)
            if kind == "kafka":
                args, kwargs = client.calls[-1]
                assert args == (queue["name"], expected_text.encode("utf-8"))
                assert kwargs == {"key": ordering.encode("utf-8")}
            elif kind == "rabbitmq":
                args, kwargs = client.calls[-1]
                assert args == (queue["name"], expected_text.encode("utf-8"))
                assert kwargs == {"message_id": envelope.id}
            else:
                assert client.calls[-1] == {
                    "QueueUrl": queue["name"],
                    "MessageBody": expected_text,
                    "MessageDeduplicationId": envelope.id,
                    "MessageGroupId": ordering,
                }
            disallowed = next(
                (item for item in behavior["messages"] if item["name"] not in queue["messages"]),
                None,
            )
            if disallowed is not None:
                bad = module.build_envelope(
                    disallowed["name"], _sample_message_payload(disallowed),
                    message_id="00000000-0000-4000-8000-000000000021",
                    occurred_at=datetime(2026, 1, 1, 0, 0, 0),
                )
                before = len(client.calls)
                with pytest.raises(module.MessageValidationError):
                    await broker.publish(queue["name"], bad)
                assert len(client.calls) == before

    _run(probe_providers())


def _check_blob(contract):
    blob = _import("app.blob")
    for name in contract["exports"]:
        assert hasattr(blob, name), name
    assert set(blob.BLOB_POLICIES) == set(contract["policies"]), sorted(map(str, blob.BLOB_POLICIES))
    try:
        blob.normalize_blob_key(contract["policies"][0], "/absolute")
        raise AssertionError("absolute keys must be rejected")
    except (ValueError, blob.BlobValidationError):
        pass
    if contract.get("behavior") is not None:
        _check_blob_behavior(blob, contract["behavior"])


def _check_blob_behavior(module, behavior):
    """Oracle v2: in-memory store lifecycle (byte limit, MIME allowlist,
    exact memory:// signed URLs) and the exact S3 call sequence under a
    fake client — same probes the terminal suite runs."""
    import pytest

    async def probe():
        store = module.InMemoryBlobStore()
        for policy in behavior["declarations"]:
            name = policy["name"]
            key = "tenant/object.bin"
            normalized = module.normalize_blob_key(name, key)
            prefix = policy["keyPrefix"].strip("/")
            assert normalized == f"{prefix + '/' if prefix else ''}{key}"
            content_type = policy["contentTypes"][0]
            await store.put(name, key, b"payload", content_type)
            assert await store.get(name, key) == b"payload"
            assert await store.signed_url(name, key) == f"memory://{policy['bucket']}/{normalized}?expires={policy['signedUrlTtlSeconds']}"
            await store.delete(name, key)
            with pytest.raises(KeyError):
                await store.get(name, key)
            with pytest.raises(module.BlobValidationError):
                await store.put(name, key, b"x" * (policy["maxBytes"] + 1), content_type)
            with pytest.raises(module.BlobValidationError):
                await store.put(name, key, b"x", "application/x-not-allowed")
            with pytest.raises(module.BlobValidationError):
                module.normalize_blob_key(name, "../secret")

    _run(probe())

    if not any(item["providerKind"] == "s3" for item in behavior["declarations"]):
        return
    assert hasattr(module, "S3BlobStore"), "S3BlobStore"

    class FakeBody:
        def __init__(self, value):
            self.value = value

        def read(self):
            return self.value

    class FakeS3Client:
        def __init__(self):
            self.objects = {}
            self.calls = []

        def put_object(self, **kwargs):
            self.calls.append(("put", kwargs))
            self.objects[(kwargs["Bucket"], kwargs["Key"])] = bytes(kwargs["Body"])

        def get_object(self, **kwargs):
            self.calls.append(("get", kwargs))
            return {"Body": FakeBody(self.objects[(kwargs["Bucket"], kwargs["Key"])])}

        def delete_object(self, **kwargs):
            self.calls.append(("delete", kwargs))
            self.objects.pop((kwargs["Bucket"], kwargs["Key"]), None)

        def generate_presigned_url(self, operation, **kwargs):
            self.calls.append(("presign", operation, kwargs))
            return "https://signed.invalid/object"

    async def probe_s3():
        policy = behavior["declarations"][0]
        name = policy["name"]
        key = "tenant/provider.bin"
        normalized = f'{policy["keyPrefix"].strip("/")}/{key}'
        content_type = policy["contentTypes"][0]
        client = FakeS3Client()
        store = module.S3BlobStore(client)
        await store.put(name, key, b"provider-payload", content_type)
        assert client.calls[-1] == ("put", {
            "Bucket": policy["bucket"], "Key": normalized,
            "Body": b"provider-payload", "ContentType": content_type,
        })
        assert await store.get(name, key) == b"provider-payload"
        assert await store.signed_url(name, key) == "https://signed.invalid/object"
        assert client.calls[-1] == ("presign", "get_object", {
            "Params": {"Bucket": policy["bucket"], "Key": normalized},
            "ExpiresIn": policy["signedUrlTtlSeconds"],
        })
        await store.delete(name, key)
        assert client.calls[-1] == ("delete", {
            "Bucket": policy["bucket"], "Key": normalized,
        })
        before = list(client.calls)
        with pytest.raises(module.BlobValidationError):
            await store.put(name, key, b"x", "application/x-not-allowed")
        assert client.calls == before

    _run(probe_s3())


def _check_app(contract):
    import importlib
    import importlib.util
    import os
    import tempfile

    main = _import("app.main")
    assert callable(getattr(main, "create_app", None)), "create_app"
    assert getattr(main, "app", None) is not None, "module-level app"
    # The registry is detection-based: importing it never raises, and it
    # includes EXACTLY the pinned candidates whose modules exist right now.
    registry = _import("app.router_registry")
    present = []
    for name in contract["registryCandidates"]:
        try:
            found = importlib.util.find_spec(name)
        except ModuleNotFoundError:
            # Skeleton time: the app.routers package does not exist yet.
            found = None
        if found is not None:
            present.append(getattr(importlib.import_module(name), "router"))
    assert list(registry.ROUTERS) == present, (
        [getattr(r, "prefix", "") for r in registry.ROUTERS],
        [getattr(r, "prefix", "") for r in present],
    )
    database_path = os.path.join(tempfile.mkdtemp(prefix="spec-oracle-"), "app.sqlite")
    application = main.create_app(database_url=f"sqlite:///{database_path}")
    # Detection wiring: the get_db override exists exactly once app.database
    # does (skeleton time: nothing to override; later: always overridden).
    if importlib.util.find_spec("app.database") is not None:
        database = _import("app.database")
        assert database.get_db in application.dependency_overrides, "get_db override missing"
    schema = application.openapi()
    expected = set()
    for router in present:
        for route in router.routes:
            if getattr(route, "methods", None):
                for method in route.methods:
                    if method != "HEAD":
                        expected.add(f"{method.upper()} {route.path}")
    actual = set(
        f"{method.upper()} {path}"
        for path, operations in schema["paths"].items()
        for method in operations
    )
    assert actual == expected, (sorted(actual), sorted(expected))
    assert schema["info"]["title"] == contract["title"], schema["info"]["title"]
    assert schema["info"]["version"] == contract["version"], schema["info"]["version"]
`
}

function oracleTestSource(contractJson: string): string {
  return `"""Compiler-owned node oracle — DO NOT EDIT (generated from the clause table)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from runner import check_contract

CONTRACT = json.loads(${pythonString(contractJson)})


def test_node_contract():
    check_contract(CONTRACT)


def test_reviewer_judged_clauses_are_explicit():
    # These clauses are deliberately NOT machine-checked here; the read-only
    # reviewer judges them by inspection against the same clause table.
    review_only = sorted(c["id"] for c in CONTRACT["clauses"] if c["verification"] == "review")
    assert isinstance(review_only, list)
`
}

export interface NodeOracleFiles {
  /** Runner + per-node oracle test files, module-relative. */
  files: Record<string, string>
  /** The command running one node's oracle file. */
  commandFor: (taskId: string) => string
}

/** The ACTUAL behavior-probe labels compiled for one node — the ground
 * truth the test manifest's in-loop coverage claims are built from. */
export function behaviorTripleLabels(bp: BackendBlueprint, taskId: string): string[] {
  const behavior = routerBehavior(bp, taskId)
  if (behavior === undefined) return []
  const triples = behavior.triples as Array<{ label?: string }>
  return triples.map((triple) => triple.label ?? "")
}

/** Build the compiler-owned oracle files for every task in the DAG. */
export function buildNodeOracles(bp: BackendBlueprint, tasks: DagTask[]): NodeOracleFiles {
  const files: Record<string, string> = { [`${ORACLE_DIR}/runner.py`]: runnerSource() }
  for (const task of tasks) {
    const contract = oracleContractFor(bp, task)
    const contractJson = stableStringify(contract)
    if (contractJson.includes('"""')) throw new Error(`oracle contract for ${task.id} cannot embed triple quotes`)
    files[oracleFileFor(task.id)] = oracleTestSource(contractJson)
  }
  return {
    files,
    commandFor: (taskId: string) => testCommandFor(bp, oracleFileFor(taskId)),
  }
}
