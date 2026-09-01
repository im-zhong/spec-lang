/**
 * Conformance suite derivation (the golden-rule oracle).
 *
 * The COMPILER — never the agent — generates a pytest suite from the
 * blueprint and drops it into every generated workspace. Whatever the
 * agent writes must pass this suite:
 *
 *   - exact route set (strict OpenAPI paths/methods equality),
 *   - exact success status codes and path params,
 *   - exact response key sets and echoed values,
 *   - exact error bodies (401/404/409) and validation statuses (422),
 *   - exact auth flow (register → login → me → protected routes),
 *   - list ordering, defaults, refs-as-id-strings.
 *
 * Same spec ⇒ same suite ⇒ all generations behave identically.
 */
import { stableStringify } from "@spec/core"
import type {
  BackendBlueprint,
  BlueprintEntity,
  BlueprintField,
  BlueprintLifecycle,
  BlueprintRoute,
} from "./blueprint"

export interface ConformanceFiles {
  /** path (relative to workspace) → file content */
  files: Record<string, string>
}

/** Sample request value for a field, as a Python literal/expression. */
function sampleValue(field: BlueprintField): string {
  switch (field.type) {
    case "string":
      // Unique string fields need per-call values or repeated creates 409.
      return field.unique
        ? `f"{uuid.uuid4()}-sample-${field.name}"`
        : JSON.stringify(`sample-${field.name}`)
    case "email":
      return `f"{uuid.uuid4()}@example.com"`
    case "int":
      return "42"
    case "boolean":
      return "True"
    case "uuid":
      return "str(uuid.uuid4())"
    case "datetime":
      return JSON.stringify("2026-01-01T12:00:00")
    case "ref":
      return JSON.stringify(`REF:${field.target ?? ""}`)
    case "enum":
      return JSON.stringify((field.states ?? [])[0] ?? "state")
  }
}

/** A second, distinct sample value for update assertions (assignable). */
function updateSample(field: BlueprintField): string {
  switch (field.type) {
    case "string":
      return field.unique
        ? `f"{uuid.uuid4()}-updated-${field.name}"`
        : JSON.stringify(`updated-${field.name}`)
    case "email":
      return `f"{uuid.uuid4()}@example.com"`
    case "int":
      return "7"
    case "boolean":
      return "False"
    case "uuid":
      return "str(uuid.uuid4())"
    case "datetime":
      return JSON.stringify("2026-02-02T12:00:00")
    case "ref":
      return "str(uuid.uuid4())"
    case "enum":
      return JSON.stringify((field.states ?? ["state"])[Math.min(1, (field.states ?? []).length - 1)])
  }
}

/** Render a JSON-ish value as a Python literal. */
function pythonLiteral(value: unknown): string {
  if (value === true) return "True"
  if (value === false) return "False"
  if (value === null || value === undefined) return "None"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return JSON.stringify(value)
  return JSON.stringify(value)
}

function createRoutesByEntity(bp: BackendBlueprint): Map<string, BlueprintRoute> {
  const map = new Map<string, BlueprintRoute>()
  for (const route of bp.routes) {
    if (route.operation === "create" && route.entity) map.set(route.entity, route)
  }
  return map
}

/** Entities whose lifecycle is testable (create route + resolvable refs). */
function lifecyclableEntities(bp: BackendBlueprint): BlueprintEntity[] {
  const createRoutes = createRoutesByEntity(bp)
  // Rows can be created via a create route, or via register for the
  // auth principal when no create route is exposed.
  const canCreate = (name: string): boolean =>
    createRoutes.has(name) || (bp.auth !== undefined && bp.auth.principal === name)
  const resolvable = (entity: BlueprintEntity, seen: Set<string>): boolean =>
    entity.fields
      .filter((f) => f.type === "ref" && f.target)
      .every((f) => {
        const target = f.target!
        if (seen.has(target)) return false
        const targetEntity = bp.entities.find((e) => e.name === target)
        if (!targetEntity || !canCreate(target)) return false
        return resolvable(targetEntity, new Set([...seen, target]))
      })
  return bp.entities.filter((e) => canCreate(e.name) && resolvable(e, new Set([e.name])))
}

/** Shortest event chain from `initial` to any of `targets`; null if unreachable. */
function pathToState(
  lifecycle: BlueprintLifecycle,
  targets: string[],
): string[] | null {
  if (targets.includes(lifecycle.initial)) return []
  const queue: Array<{ state: string; path: string[] }> = [{ state: lifecycle.initial, path: [] }]
  const seen = new Set([lifecycle.initial])
  while (queue.length > 0) {
    const { state, path } = queue.shift()!
    for (const t of lifecycle.transitions) {
      if (!t.from.includes(state)) continue
      if (seen.has(t.to)) continue
      const next = { state: t.to, path: [...path, t.event] }
      if (targets.includes(t.to)) return next.path
      seen.add(t.to)
      queue.push(next)
    }
  }
  return null
}

/** First comparison in a check tree (DFS), if any. */
function findFirstCmp(check: unknown): Record<string, unknown> | undefined {
  if (!check || typeof check !== "object") return undefined
  const node = check as Record<string, unknown>
  if (node.__expr === "cmp") return node
  if (node.__expr === "and") {
    return findFirstCmp(node.left) ?? findFirstCmp(node.right)
  }
  return undefined
}

/** The field compared against a const in a cmp node ("left" or "right"). */
function cmpFieldName(cmp: Record<string, unknown>): string | undefined {
  const left = cmp.left as Record<string, unknown> | undefined
  const right = cmp.right as Record<string, unknown> | undefined
  if (left?.__expr === "field" && right?.__expr === "const") return String(left.name)
  if (right?.__expr === "field" && left?.__expr === "const") return String(right.name)
  return undefined
}

/** A Python literal/expression that VIOLATES the comparison, or undefined. */
function violatingValue(
  entity: BlueprintEntity,
  fieldName: string | undefined,
  cmp: Record<string, unknown>,
): string | undefined {
  if (!fieldName) return undefined
  const field = entity.fields.find((f) => f.name === fieldName)
  if (!field) return undefined
  const left = cmp.left as Record<string, unknown> | undefined
  const right = cmp.right as Record<string, unknown> | undefined
  const op = String(cmp.op)
  // normalize so `bound` is the const and the field side is known
  let bound: unknown
  if (right?.__expr === "const") bound = right.value
  else if (left?.__expr === "const") bound = left.value
  else return undefined
  const flip = left?.__expr === "const" // field on the right → mirror the op
  const mirror: Record<string, string> = { lt: "gt", lte: "gte", gt: "lt", gte: "lte", eq: "eq", neq: "neq" }
  const effOp = flip ? mirror[op] : op

  if (typeof bound === "number" && field.type === "int") {
    const v =
      effOp === "neq" ? bound :
      effOp === "eq" ? bound + 1 :
      effOp === "lt" || effOp === "lte" ? bound + 1 :
      bound - 1
    return String(v)
  }
  if (typeof bound === "string" && (field.type === "string" || field.type === "enum")) {
    if (field.type === "enum") {
      const others = (field.states ?? []).filter((s) => s !== bound)
      if (effOp === "neq") return JSON.stringify(bound)
      if (others.length > 0) return JSON.stringify(others[0])
      return undefined
    }
    if (effOp === "neq") return JSON.stringify(bound)
    if (effOp === "eq") return JSON.stringify(bound + "-different")
    return undefined
  }
  if (typeof bound === "boolean" && field.type === "boolean") {
    if (effOp === "eq") return bound ? "False" : "True"
    if (effOp === "neq") return bound ? "True" : "False"
    return undefined
  }
  return undefined
}

/** Python expression for a route path with {id} filled from a variable. */
function pathExpr(route: BlueprintRoute, idVar: string): string {
  if (route.path.includes("{id}")) {
    return `${JSON.stringify(route.path)}.replace("{id}", ${idVar})`
  }
  return JSON.stringify(route.path)
}

export function buildConformanceSuite(bp: BackendBlueprint): ConformanceFiles {
  const createRoutes = createRoutesByEntity(bp)
  const lifecycles = lifecyclableEntities(bp)
  const hasAuth = bp.auth !== undefined

  /* ================= conftest.py ================= */
  const conf: string[] = []
  conf.push('"""Compiler-generated conformance harness — DO NOT EDIT."""')
  conf.push("")
  conf.push("import pytest")
  conf.push("from fastapi.testclient import TestClient")
  conf.push("")
  conf.push("from app.main import create_app")
  conf.push("")
  conf.push("")
  conf.push("@pytest.fixture()")
  conf.push("def client(tmp_path):")
  conf.push('    """Fresh app + isolated SQLite database per test."""')
  conf.push('    application = create_app(database_url=f"sqlite:///{tmp_path}/test.db")')
  conf.push("    with TestClient(application) as test_client:")
  conf.push("        yield test_client")
  const conftest = conf.join("\n") + "\n"

  /* ================= helpers.py ================= */
  const c: string[] = []
  c.push('"""Compiler-generated conformance helpers — DO NOT EDIT."""')
  c.push("")
  c.push("import uuid")
  c.push("")
  c.push("")
  c.push("def make_body(client, entity, overrides=None, token=None):")
  c.push('    """Build a valid create body for entity (seeding ref targets).')
  c.push("")
  c.push("    Does NOT create the row itself — used by invariant tests that")
  c.push("    need a body for a create that must FAIL.")
  c.push('"""')
  for (const entity of lifecycles) {
    const create = createRoutes.get(entity.name)
    if (!create) continue // principal-without-create has no dict form
    c.push(`    if entity == ${JSON.stringify(entity.name)}:`)
    const seeds: string[] = []
    for (const field of entity.fields) {
      if (field.type === "ref" && field.target) {
        const varName = `_${field.target.toLowerCase()}`
        c.push(
          `        ${varName} = create_row(client, ${JSON.stringify(field.target)}, token=token)`,
        )
        seeds.push(`${JSON.stringify(field.name)}: ${varName}["id"]`)
      }
    }
    const parts: string[] = [...seeds]
    for (const field of entity.fields) {
      // id is server-generated; refs are seeded; optional and defaulted
      // fields are omittable (the pinned default/None must apply).
      if (field.name === "id" || field.type === "ref" || field.optional || field.default !== undefined) {
        continue
      }
      parts.push(`${JSON.stringify(field.name)}: ${sampleValue(field)}`)
    }
    c.push(`        base = {${parts.join(", ")}}`)
    c.push("        if overrides:")
    c.push("            base.update(overrides)")
    c.push("        return base")
  }
  c.push(`    raise AssertionError(f"no body builder for {entity}")`)
  c.push("")
  c.push("")
  c.push("def body_for(client, entity, overrides=None, token=None):")
  c.push('    """Make a body and CREATE the row; returns (sent_body, stored_json)."""')
  for (const entity of lifecycles) {
    const create = createRoutes.get(entity.name)
    c.push(`    if entity == ${JSON.stringify(entity.name)}:`)
    if (!create) {
      // Principal without an exposed create route: seed via register.
      const reg = bp.auth!.routes.find((r) => r.operation === "register")!
      const identity = bp.auth!.identityField
      const parts: string[] = []
      for (const field of entity.fields) {
        if (field.name === "id" || field.name === identity) continue
        if (field.type === "ref" || field.optional || field.default !== undefined) continue
        parts.push(`${JSON.stringify(field.name)}: ${sampleValue(field)}`)
      }
      c.push(`        identity = f"{uuid.uuid4()}@example.com"`)
      c.push(
        `        body = {${JSON.stringify(identity)}: identity, ${parts.join(", ")}, "password": "secret123"}`,
      )
      c.push(`        r = client.post(${JSON.stringify(reg.path)}, json=body)`)
      c.push("        assert r.status_code == 201, r.text")
      c.push("        return body, r.json()")
      continue
    }
    const hdrs = hasAuth && create.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
    c.push(`        base = make_body(client, entity, overrides=overrides, token=token)`)
    c.push(`        r = client.post(${JSON.stringify(create.path)}, json=base${hdrs})`)
    c.push("        assert r.status_code == 201, r.text")
    c.push("        return base, r.json()")
  }
  c.push(`    raise AssertionError(f"no body builder for {entity}")`)
  c.push("")
  c.push("")
  c.push("def create_row(client, entity, overrides=None, token=None):")
  c.push('    """Create one row of entity; returns the stored json."""')
  c.push("    _, stored = body_for(client, entity, overrides=overrides, token=token)")
  c.push("    return stored")
  if (hasAuth) {
    const principal = bp.entities.find((e) => e.name === bp.auth!.principal)!
    const identity = bp.auth!.identityField
    const register = bp.auth!.routes.find((r) => r.operation === "register")!
    const login = bp.auth!.routes.find((r) => r.operation === "login")!
    const regParts: string[] = [`${JSON.stringify(identity)}: identity`]
    for (const field of principal.fields) {
      if (field.name === "id" || field.name === identity) continue
      if (field.type === "ref" || field.optional || field.default !== undefined) continue
      regParts.push(`${JSON.stringify(field.name)}: ${sampleValue(field)}`)
    }
    regParts.push(`"password": password`)
    c.push("")
    c.push("")
    c.push("def auth_user(client, identity=None, password='secret123'):")
    c.push('    """Register + login a principal; returns (identity, token)."""')
    c.push(`    identity = identity or f"{uuid.uuid4()}@example.com"`)
    c.push(
      `    r = client.post(${JSON.stringify(register.path)}, json={${regParts.join(", ")}})`,
    )
    c.push("    assert r.status_code == 201, r.text")
    c.push(
      `    r = client.post(${JSON.stringify(login.path)}, json={${JSON.stringify(identity)}: identity, "password": password})`,
    )
    c.push("    assert r.status_code == 200, r.text")
    c.push('    assert r.json()["token_type"] == "bearer"')
    c.push('    return identity, r.json()["access_token"]')
    c.push("")
    c.push("")
    c.push("def auth_token(client):")
    c.push("    return auth_user(client)[1]")
  }
  const helpers = c.join("\n") + "\n"

  /* ================= test_contract.py ================= */
  const t: string[] = []
  t.push('"""Compiler-generated conformance suite — DO NOT EDIT.')
  t.push("")
  t.push("Derived from the specification. Every generated implementation of")
  t.push("this specification must pass this suite with identical behavior.")
  t.push('"""')
  t.push("import uuid")
  t.push("")
  t.push(
    "from helpers import body_for, create_row, make_body" +
      (hasAuth ? ", auth_user, auth_token" : ""),
  )
  t.push("")
  t.push("")

  // ---- interface (strict OpenAPI equality) ----
  const expected: Record<string, { statuses: string[]; pathParams: string[] }> = {}
  for (const route of bp.routes) {
    expected[route.id] = {
      statuses: [String(route.status)],
      pathParams: route.path.includes("{id}") ? ["id"] : [],
    }
  }
  t.push("# The exact interface the specification defines (strict equality).")
  t.push(`EXPECTED_INTERFACE = ${pythonInterfaceLiteral(expected)}`)
  t.push("")
  t.push("")
  t.push("def _normalize(spec):")
  t.push('    """Paths/methods/statuses/path-params of an OpenAPI document."""')
  t.push("    out = {}")
  t.push('    for path, ops in spec.get("paths", {}).items():')
  t.push("        for method, op in ops.items():")
  t.push('            if method not in ("get", "post", "put", "patch", "delete"):')
  t.push("                continue")
  t.push('            statuses = sorted(op.get("responses", {}).keys())')
  t.push(
    '            params = sorted(p["name"] for p in op.get("parameters", []) if p.get("in") == "path")',
  )
  t.push('            out[f"{method.upper()} {path}"] = {"statuses": statuses, "pathParams": params}')
  t.push("    return out")
  t.push("")
  t.push("")
  t.push("def test_interface_matches_specification(client):")
  t.push('    r = client.get("/openapi.json")')
  t.push("    assert r.status_code == 200, r.text")
  t.push("    actual = _normalize(r.json())")
  t.push("    expected_keys = set(EXPECTED_INTERFACE.keys())")
  t.push("    assert set(actual.keys()) == expected_keys, (")
  t.push("        sorted(set(actual.keys()) - expected_keys),")
  t.push("        sorted(expected_keys - set(actual.keys())),")
  t.push("    )")
  t.push("    for route_id, exp in EXPECTED_INTERFACE.items():")
  t.push('        assert actual[route_id]["pathParams"] == exp["pathParams"], route_id')
  t.push('        assert exp["statuses"][0] in actual[route_id]["statuses"], route_id')
  t.push("")

  // ---- auth flow ----
  if (hasAuth) {
    const auth = bp.auth!
    const principal = bp.entities.find((e) => e.name === auth.principal)!
    const identity = auth.identityField
    const principalKeys = principal.fields.map((f) => f.name)
    const login = auth.routes.find((r) => r.operation === "login")!
    const register = auth.routes.find((r) => r.operation === "register")!
    const me = auth.routes.find((r) => r.operation === "me")!
    const regParts: string[] = [`${JSON.stringify(identity)}: identity`]
    for (const field of principal.fields) {
      if (field.name === "id" || field.name === identity) continue
      if (field.type === "ref" || field.optional || field.default !== undefined) continue
      regParts.push(`${JSON.stringify(field.name)}: ${sampleValue(field)}`)
    }

    t.push("")
    t.push("# ------------------------------------------------------------------")
    t.push("# Auth flow")
    t.push("# ------------------------------------------------------------------")
    t.push("def test_register_login_me(client):")
    t.push("    identity, token = auth_user(client)")
    t.push(
      `    r = client.get(${JSON.stringify(me.path)}, headers={"Authorization": f"Bearer {token}"})`,
    )
    t.push("    assert r.status_code == 200, r.text")
    t.push(`    assert set(r.json().keys()) == ${pythonSetLiteral(principalKeys)}`)
    t.push(`    assert r.json()[${JSON.stringify(identity)}] == identity`)
    t.push(`    assert ${JSON.stringify(auth.passwordColumn)} not in r.json()`)
    t.push("")
    t.push("def test_login_wrong_password(client):")
    t.push(`    identity, _ = auth_user(client, password="correct-horse")`)
    t.push(
      `    r = client.post(${JSON.stringify(login.path)}, json={${JSON.stringify(identity)}: identity, "password": "wrong"})`,
    )
    t.push("    assert r.status_code == 401, r.text")
    t.push('    assert r.json() == {"detail": "Invalid credentials"}')
    t.push("")
    t.push("def test_login_unknown_identity(client):")
    t.push(
      `    r = client.post(${JSON.stringify(login.path)}, json={${JSON.stringify(identity)}: f"{uuid.uuid4()}@example.com", "password": "x"})`,
    )
    t.push("    assert r.status_code == 401, r.text")
    t.push('    assert r.json() == {"detail": "Invalid credentials"}')
    t.push("")
    t.push("def test_register_duplicate_identity(client):")
    t.push("    identity, _ = auth_user(client)")
    t.push(
      `    r = client.post(${JSON.stringify(register.path)}, json={${regParts.join(", ")}, "password": "another-secret"})`,
    )
    t.push("    assert r.status_code == 409, r.text")
    t.push('    assert r.json() == {"detail": "Already exists"}')
    t.push("")
    t.push("def test_me_without_token(client):")
    t.push(`    r = client.get(${JSON.stringify(me.path)})`)
    t.push("    assert r.status_code == 401, r.text")
    t.push('    assert r.json() == {"detail": "Not authenticated"}')
    t.push("")

    const protectedRoutes = bp.routes.filter((r) => r.auth && r.operation !== "me")
    if (protectedRoutes.length > 0) {
      t.push("def test_protected_routes_require_token(client):")
      for (const route of protectedRoutes) {
        t.push(`    r = ${requestExpr(route, "str(uuid.uuid4())")}`)
        t.push(`    assert r.status_code == 401, ${JSON.stringify(route.id)}`)
        t.push('    assert r.json() == {"detail": "Not authenticated"}')
      }
    }
  }

  // ---- entity lifecycles ----
  for (const entity of lifecycles) {
    const create = createRoutes.get(entity.name)
    const withAuth = hasAuth && create !== undefined && create.auth
    const tokenArg = withAuth ? ", token=token" : ""
    const keys = entity.fields.map((f) => f.name)
    const lower = entity.name.toLowerCase()
    const routes = bp.routes.filter((r) => r.entity === entity.name)

    t.push("")
    t.push("# ------------------------------------------------------------------")
    t.push(`# ${entity.name}`)
    t.push("# ------------------------------------------------------------------")

    if (routes.some((r) => r.operation === "create")) {
      t.push(`def test_${lower}_create(client):`)
      if (withAuth) t.push("    token = auth_token(client)")
      t.push(`    body, stored = body_for(client, ${JSON.stringify(entity.name)}${tokenArg})`)
      t.push(`    assert set(stored.keys()) == ${pythonSetLiteral(keys)}`)
      if (keys.includes("id")) {
        t.push('    assert isinstance(stored["id"], str) and stored["id"]')
      }
      const lifecycle = bp.lifecycles.find((l) => l.entity === entity.name)
      for (const field of entity.fields) {
        if (field.name === "id") continue
        if (lifecycle && field.name === lifecycle.field) {
          t.push(`    assert stored[${JSON.stringify(field.name)}] == ${JSON.stringify(lifecycle.initial)}`)
          continue
        }
        if (field.type === "ref") {
          t.push(`    assert stored[${JSON.stringify(field.name)}] == body[${JSON.stringify(field.name)}]`)
          continue
        }
        if (field.default !== undefined) {
          t.push(`    assert stored[${JSON.stringify(field.name)}] == ${pythonLiteral(field.default)}`)
          continue
        }
        if (field.optional) {
          t.push(`    assert stored[${JSON.stringify(field.name)}] is None`)
          continue
        }
        t.push(`    assert stored[${JSON.stringify(field.name)}] == body[${JSON.stringify(field.name)}]`)
      }
    }

    for (const route of routes) {
      const suffix = hasAuth && route.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
      const needsToken = hasAuth && route.auth
      switch (route.operation) {
        case "get":
          t.push("")
          t.push("")
          t.push(`def test_${lower}_get(client):`)
          if (needsToken) t.push("    token = auth_token(client)")
          t.push(`    stored = create_row(client, ${JSON.stringify(entity.name)}${tokenArg})`)
          t.push(`    r = client.get(${pathExpr(route, 'stored["id"]')}${suffix})`)
          t.push("    assert r.status_code == 200, r.text")
          t.push(`    assert set(r.json().keys()) == ${pythonSetLiteral(keys)}`)
          t.push('    assert r.json()["id"] == stored["id"]')
          t.push(`    r = client.get(${pathExpr(route, "str(uuid.uuid4())")}${suffix})`)
          t.push("    assert r.status_code == 404, r.text")
          t.push('    assert r.json() == {"detail": "Not found"}')
          break
        case "list":
          t.push("")
          t.push("")
          t.push(`def test_${lower}_list(client):`)
          if (needsToken) t.push("    token = auth_token(client)")
          // listScope: "allRows" — when the listed entity IS the auth
          // principal, the token's own row is part of the list (created
          // first, so it leads the createdAt ordering).
          if (needsToken && hasAuth && bp.auth!.principal === entity.name) {
            t.push(`    me = client.get(${JSON.stringify(mePath(bp))}, headers={"Authorization": f"Bearer {token}"})`)
            t.push("    assert me.status_code == 200, me.text")
            t.push(`    first = create_row(client, ${JSON.stringify(entity.name)}${tokenArg})`)
            t.push(`    second = create_row(client, ${JSON.stringify(entity.name)}${tokenArg})`)
            t.push(`    r = client.get(${JSON.stringify(route.path)}${suffix})`)
            t.push("    assert r.status_code == 200, r.text")
            t.push("    rows = r.json()")
            t.push("    assert isinstance(rows, list)")
            t.push('    assert [row["id"] for row in rows] == [me.json()["id"], first["id"], second["id"]]')
          } else {
            t.push(`    first = create_row(client, ${JSON.stringify(entity.name)}${tokenArg})`)
            t.push(`    second = create_row(client, ${JSON.stringify(entity.name)}${tokenArg})`)
            t.push(`    r = client.get(${JSON.stringify(route.path)}${suffix})`)
            t.push("    assert r.status_code == 200, r.text")
            t.push("    rows = r.json()")
            t.push("    assert isinstance(rows, list)")
            t.push('    assert [row["id"] for row in rows] == [first["id"], second["id"]]')
          }
          t.push(`    assert set(rows[0].keys()) == ${pythonSetLiteral(keys)}`)
          break
        case "update": {
          const patchField = entity.fields.find(
            (f) => f.name !== "id" && f.type !== "ref" && !f.optional,
          )
          t.push("")
          t.push("")
          t.push(`def test_${lower}_update(client):`)
          if (needsToken) t.push("    token = auth_token(client)")
          t.push(`    stored = create_row(client, ${JSON.stringify(entity.name)}${tokenArg})`)
          if (patchField) {
            t.push(`    new_value = ${updateSample(patchField)}`)
            t.push(
              `    r = client.patch(${pathExpr(route, 'stored["id"]')}, json={${JSON.stringify(patchField.name)}: new_value}${suffix})`,
            )
            t.push("    assert r.status_code == 200, r.text")
            t.push(`    assert r.json()[${JSON.stringify(patchField.name)}] == new_value`)
          } else {
            t.push(`    r = client.patch(${pathExpr(route, 'stored["id"]')}, json={}${suffix})`)
            t.push("    assert r.status_code == 200, r.text")
          }
          t.push('    assert r.json()["id"] == stored["id"]')
          t.push(`    r = client.patch(${pathExpr(route, "str(uuid.uuid4())")}, json={}${suffix})`)
          t.push("    assert r.status_code == 404, r.text")
          t.push('    assert r.json() == {"detail": "Not found"}')
          break
        }
        case "delete":
          t.push("")
          t.push("")
          t.push(`def test_${lower}_delete(client):`)
          if (needsToken) t.push("    token = auth_token(client)")
          t.push(`    stored = create_row(client, ${JSON.stringify(entity.name)}${tokenArg})`)
          t.push(`    r = client.delete(${pathExpr(route, 'stored["id"]')}${suffix})`)
          t.push("    assert r.status_code == 204, r.text")
          t.push('    assert r.content == b""')
          t.push(`    r = client.delete(${pathExpr(route, 'stored["id"]')}${suffix})`)
          t.push("    assert r.status_code == 404, r.text")
          break
        case "create":
          // validation / uniqueness / dangling ref
          t.push("")
          t.push("")
          t.push(`def test_${lower}_create_validation(client):`)
          if (needsToken) t.push("    token = auth_token(client)")
          t.push(`    body, _ = body_for(client, ${JSON.stringify(entity.name)}${tokenArg})`)
          const badField = entity.fields.find((f) => f.type === "int" && !f.optional)
          if (badField) {
            t.push(`    bad = {**body, ${JSON.stringify(badField.name)}: "not-an-int"}`)
            t.push(`    r = client.post(${JSON.stringify(route.path)}, json=bad${suffix})`)
            t.push("    assert r.status_code == 422, r.text")
            t.push('    assert isinstance(r.json()["detail"], list)')
          }
          const uniqueField = entity.fields.find((f) => f.unique && f.type !== "ref" && !f.optional)
          if (uniqueField && (!hasAuth || entity.name !== bp.auth!.principal)) {
            t.push(`    body2, _ = body_for(client, ${JSON.stringify(entity.name)}${tokenArg})`)
            t.push(
              `    dup = {**body2, ${JSON.stringify(uniqueField.name)}: body[${JSON.stringify(uniqueField.name)}]}`,
            )
            t.push(`    r = client.post(${JSON.stringify(route.path)}, json=dup${suffix})`)
            t.push("    assert r.status_code == 409, r.text")
            t.push('    assert r.json() == {"detail": "Already exists"}')
          }
          const refField = entity.fields.find((f) => f.type === "ref")
          if (refField) {
            t.push(`    body3, _ = body_for(client, ${JSON.stringify(entity.name)}${tokenArg})`)
            t.push(
              `    dangling = {**body3, ${JSON.stringify(refField.name)}: str(uuid.uuid4())}`,
            )
            t.push(`    r = client.post(${JSON.stringify(route.path)}, json=dangling${suffix})`)
            t.push("    assert r.status_code == 404, r.text")
            t.push('    assert r.json() == {"detail": "Not found"}')
          }
          break
      }
    }
  }

  // ---- lifecycle transitions (behavior Phase 1) ----
  for (const lifecycle of bp.lifecycles) {
    const entity = bp.entities.find((e) => e.name === lifecycle.entity)
    if (!entity || !lifecycles.includes(entity)) continue
    const lower = lifecycle.entity.toLowerCase()
    const withAuth = hasAuth
    const tokenLine = withAuth ? '    token = auth_token(client)' : ""
    const headers = withAuth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
    const tokenArg = withAuth ? ", token=token" : ""

    for (const route of bp.routes.filter(
      (r) => r.operation === "transition" && r.entity === lifecycle.entity && r.transition?.event,
    )) {
      const event = route.transition!.event
      const chain = pathToState(lifecycle, route.transition!.from)
      if (chain !== null) {
        t.push("")
        t.push("")
        t.push(`def test_transition_${event}(client):`)
        if (withAuth) t.push(tokenLine)
        t.push(`    row = create_row(client, ${JSON.stringify(lifecycle.entity)}${tokenArg})`)
        // pre-apply the chain that brings the row into a from-state
        for (const step of chain) {
          const stepRoute = bp.routes.find(
            (r) => r.operation === "transition" && r.entity === lifecycle.entity && r.transition?.event === step,
          )
          if (stepRoute) {
            t.push(`    client.post(${pathExpr(stepRoute, 'row["id"]')}${headers})`)
          }
        }
        t.push(`    r = client.post(${pathExpr(route, 'row["id"]')}${headers})`)
        t.push("    assert r.status_code == 200, r.text")
        t.push(`    assert r.json()[${JSON.stringify(lifecycle.field)}] == ${JSON.stringify(route.transition!.to)}`)
        t.push('    assert r.json()["id"] == row["id"]')
        t.push(`    assert set(r.json().keys()) == ${pythonSetLiteral(entity.fields.map((f) => f.name))}`)
        // applying again from the to-state is illegal (unless self-loop)
        if (!route.transition!.from.includes(route.transition!.to)) {
          t.push(`    r = client.post(${pathExpr(route, 'row["id"]')}${headers})`)
          t.push("    assert r.status_code == 409, r.text")
          t.push('    assert r.json() == {"detail": "Invalid state"}')
        }
        t.push(`    r = client.post(${pathExpr(route, "str(uuid.uuid4())")}${headers})`)
        t.push("    assert r.status_code == 404, r.text")
        t.push('    assert r.json() == {"detail": "Not found"}')
      }
    }

    // create assigns the initial state; update ignores the state field
    const updateRoute = bp.routes.find((r) => r.operation === "update" && r.entity === lifecycle.entity)
    if (updateRoute) {
      t.push("")
      t.push("")
      t.push(`def test_${lower}_update_ignores_${lifecycle.field}(client):`)
      if (withAuth) t.push(tokenLine)
      t.push(`    row = create_row(client, ${JSON.stringify(lifecycle.entity)}${tokenArg})`)
      const otherState = (entity.fields.find((f) => f.name === lifecycle.field)?.states ?? [])
        .filter((s) => s !== lifecycle.initial)
      const probeState = otherState[0] ?? lifecycle.initial
      t.push(`    r = client.patch(${pathExpr(updateRoute, 'row["id"]')}, json={${JSON.stringify(lifecycle.field)}: ${JSON.stringify(probeState)}}${headers})`)
      t.push("    assert r.status_code == 200, r.text")
      t.push(`    assert r.json()[${JSON.stringify(lifecycle.field)}] == row[${JSON.stringify(lifecycle.field)}]`)
    }
  }

  // ---- invariants (behavior Phase 2): minimally violating worlds ----
  for (const inv of bp.invariants) {
    const onEntity = bp.entities.find((e) => e.name === inv.entity)
    const withAuth = hasAuth

    if (inv.shape === "rowCheck" && onEntity) {
      // Find the first comparison with a const bound and compute a value
      // that violates it.
      const firstCmp = findFirstCmp(inv.check)
      const field = firstCmp ? cmpFieldName(firstCmp) : undefined
      const value = firstCmp ? violatingValue(onEntity, field, firstCmp) : undefined
      const create = createRoutes.get(inv.entity)
      if (firstCmp && field && value !== undefined && create && lifecycles.includes(onEntity)) {
        const suffix = withAuth && create.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
        const tokenArg = withAuth && create.auth ? ", token=token" : ""
        t.push("")
        t.push("")
        t.push(`def test_invariant_${inv.name.replace(/[^a-zA-Z0-9_]/g, "_")}(client):`)
        if (withAuth && create.auth) t.push("    token = auth_token(client)")
        t.push(`    good = make_body(client, ${JSON.stringify(inv.entity)}${tokenArg})`)
        t.push(`    bad = {**good, ${JSON.stringify(field)}: ${value}}`)
        t.push(`    r = client.post(${JSON.stringify(create.path)}, json=bad${suffix})`)
        t.push("    assert r.status_code == 409, r.text")
        t.push('    assert r.json() == {"detail": "Invariant violated"}')
        const countRoute = bp.routes.find(
          (r) => r.operation === "count" && r.entity === inv.entity && (!withAuth || r.auth === (create.auth ?? false)),
        )
        if (countRoute) {
          const cSuffix = withAuth && countRoute.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
          t.push(`    r = client.get(${JSON.stringify(countRoute.path)}${cSuffix})`)
          t.push("    assert r.status_code == 200, r.text")
          t.push(`    assert r.json() == {"count": 0}`)
        }
      }
    }

    if (inv.shape === "crossRowCount" && onEntity) {
      const c = inv.count!
      const countedCreate = createRoutes.get(c.entity)
      const onCreate = createRoutes.get(inv.entity)
      const onUpdate = bp.routes.find((r) => r.operation === "update" && r.entity === inv.entity)
      const countedEntity = bp.entities.find((e) => e.name === c.entity)
      const boundIsField = c.bound.kind === "field"
      if (
        countedCreate &&
        countedEntity &&
        lifecycles.includes(countedEntity) &&
        onEntity &&
        (boundIsField ? onCreate && onUpdate : true)
      ) {
        const cSuffix = withAuth && countedCreate.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
        const cTokenArg = withAuth && countedCreate.auth ? ", token=token" : ""
        const boundField = c.bound.kind === "field" ? c.bound.name : undefined
        const boundConst = c.bound.kind === "const" ? c.bound.value : undefined
        t.push("")
        t.push("")
        t.push(`def test_invariant_${inv.name.replace(/[^a-zA-Z0-9_]/g, "_")}(client):`)
        if (withAuth && countedCreate.auth) t.push("    token = auth_token(client)")
        if (boundIsField && onCreate && boundField) {
          const onSuffix = withAuth && onCreate.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
          // 1) a zero-capacity bound: ANY create of the counted entity fails
          t.push(`    tight = create_row(client, ${JSON.stringify(inv.entity)}${onCreate.auth && withAuth ? ", token=token" : ""}, overrides={${JSON.stringify(boundField)}: 0})`)
          t.push(`    body = make_body(client, ${JSON.stringify(c.entity)}${cTokenArg})`)
          t.push(`    body[${JSON.stringify(c.refField)}] = tight["id"]`)
          t.push(`    r = client.post(${JSON.stringify(countedCreate.path)}, json=body${cSuffix})`)
          t.push("    assert r.status_code == 409, r.text")
          t.push('    assert r.json() == {"detail": "Invariant violated"}')
          // 2) relax the bound by one: exactly one create succeeds, the next fails
          if (onUpdate) {
            const uSuffix = withAuth && onUpdate.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
            t.push(`    r = client.patch(${pathExpr(onUpdate, 'tight["id"]')}, json={${JSON.stringify(boundField)}: 1}${uSuffix})`)
            t.push("    assert r.status_code == 200, r.text")
          }
          t.push(`    body = make_body(client, ${JSON.stringify(c.entity)}${cTokenArg})`)
          t.push(`    body[${JSON.stringify(c.refField)}] = tight["id"]`)
          t.push(`    r = client.post(${JSON.stringify(countedCreate.path)}, json=body${cSuffix})`)
          t.push("    assert r.status_code == 201, r.text")
          t.push(`    body = make_body(client, ${JSON.stringify(c.entity)}${cTokenArg})`)
          t.push(`    body[${JSON.stringify(c.refField)}] = tight["id"]`)
          t.push(`    r = client.post(${JSON.stringify(countedCreate.path)}, json=body${cSuffix})`)
          t.push("    assert r.status_code == 409, r.text")
          t.push('    assert r.json() == {"detail": "Invariant violated"}')
          // 3) tightening the bound below the live count also fails
          if (onUpdate) {
            const uSuffix2 = withAuth && onUpdate.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
            t.push(`    r = client.patch(${pathExpr(onUpdate, 'tight["id"]')}, json={${JSON.stringify(boundField)}: 0}${uSuffix2})`)
            t.push("    assert r.status_code == 409, r.text")
            t.push('    assert r.json() == {"detail": "Invariant violated"}')
          }
          void onSuffix
        } else if (boundConst !== undefined) {
          // const bound N: the first N creates succeed, the (N+1)-th fails
          const N = Math.max(0, Math.min(boundConst, 3))
          t.push(`    holder = create_row(client, ${JSON.stringify(inv.entity)}${onCreate && hasAuth && onCreate.auth ? ", token=token" : ""})`)
          for (let i = 0; i < N; i++) {
            t.push(`    body = make_body(client, ${JSON.stringify(c.entity)}${cTokenArg})`)
            t.push(`    body[${JSON.stringify(c.refField)}] = holder["id"]`)
            t.push(`    r = client.post(${JSON.stringify(countedCreate.path)}, json=body${cSuffix})`)
            t.push("    assert r.status_code == 201, r.text")
          }
          t.push(`    body = make_body(client, ${JSON.stringify(c.entity)}${cTokenArg})`)
          t.push(`    body[${JSON.stringify(c.refField)}] = holder["id"]`)
          t.push(`    r = client.post(${JSON.stringify(countedCreate.path)}, json=body${cSuffix})`)
          t.push("    assert r.status_code == 409, r.text")
          t.push('    assert r.json() == {"detail": "Invariant violated"}')
        }
      }
    }
  }

  // ---- count endpoints ----
  for (const route of bp.routes.filter((r) => r.operation === "count")) {
    const entityName = route.entity!
    const create = createRoutes.get(entityName)
    const needsToken = hasAuth && route.auth
    const suffix = needsToken ? ', headers={"Authorization": f"Bearer {token}"}' : ""
    const tokenArg = needsToken ? ", token=token" : ""
    // The token itself is created via register: when counting the
    // principal entity, that row is already present (listScope allRows).
    const principalOffset =
      needsToken && hasAuth && bp.auth!.principal === entityName ? 1 : 0
    t.push("")
    t.push("")
    t.push(`def test_count_${entityName.toLowerCase()}(client):`)
    if (needsToken) t.push("    token = auth_token(client)")
    t.push(`    r = client.get(${JSON.stringify(route.path)}${suffix})`)
    t.push("    assert r.status_code == 200, r.text")
    t.push(`    assert r.json() == {"count": ${principalOffset}}`)
    if (create) {
      t.push(`    create_row(client, ${JSON.stringify(entityName)}${tokenArg})`)
      t.push(`    r = client.get(${JSON.stringify(route.path)}${suffix})`)
      t.push("    assert r.status_code == 200, r.text")
      t.push(`    assert r.json() == {"count": ${principalOffset + 1}}`)
    }
  }

  return {
    files: {
      "conformance/conftest.py": conftest,
      "conformance/helpers.py": helpers,
      "conformance/test_contract.py": t.join("\n") + "\n",
      "conformance/contract.json": stableStringify(bp) + "\n",
    },
  }
}

/** Bare request expression used by the no-token protection tests. */
function requestExpr(route: BlueprintRoute, idExpr: string): string {
  const path = pathExpr(route, idExpr)
  switch (route.method) {
    case "GET":
      return `client.get(${path})`
    case "POST":
      return `client.post(${path}, json={})`
    case "PATCH":
      return `client.patch(${path}, json={})`
    case "PUT":
      return `client.put(${path}, json={})`
    case "DELETE":
      return `client.delete(${path})`
  }
}

function pythonInterfaceLiteral(
  value: Record<string, { statuses: string[]; pathParams: string[] }>,
): string {
  const entries = Object.entries(value).map(([key, val]) => {
    const statuses = `[${val.statuses.map((s) => `"${s}"`).join(", ")}]`
    const params = `[${val.pathParams.map((p) => `"${p}"`).join(", ")}]`
    return `    ${JSON.stringify(key)}: {"statuses": ${statuses}, "pathParams": ${params}}`
  })
  return "{\n" + entries.join(",\n") + ",\n}"
}

function pythonSetLiteral(values: string[]): string {
  return `{${values.map((v) => JSON.stringify(v)).join(", ")}}`
}

/** Path of the GET /auth/me route (asserted to exist when auth is active). */
function mePath(bp: BackendBlueprint): string {
  return bp.auth!.routes.find((r) => r.operation === "me")!.path
}
