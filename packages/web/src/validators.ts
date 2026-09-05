/**
 * Web package semantics (validation layer 4: package semantics).
 *
 * All web-specific rules live HERE, never in the compiler core.
 */
import type { Diagnostic, SpecNode } from "@spec/core"
import { defineValidator, diag } from "@spec/package-sdk"
import { CRUD_METHODS, defaultCrudPath } from "./crud"
import { FIELD_TYPES } from "./field"

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Duplicate entity names, duplicate field names, invalid field definitions. */
export const validateEntities = defineValidator("web/validate-entities", (ctx) => {
  const diagnostics: Diagnostic[] = []
  const entities = ctx.findNodes("entity")
  const seen = new Map<string, SpecNode>()

  for (const node of entities) {
    const name = node.name ?? ""
    const previous = seen.get(name)
    if (previous) {
      diagnostics.push(
        diag(
          "DUPLICATE_ENTITY_NAME",
          "error",
          `Duplicate entity name "${name}" (already defined at ${previous.source ? `${previous.source.file}:${previous.source.line}` : "unknown location"}).`,
          { nodeId: node.id, details: { entity: name, firstNode: previous.id } },
        ),
      )
    } else {
      seen.set(name, node)
    }
    diagnostics.push(...validateFields(node, entities))
  }
  return diagnostics
})

function validateFields(node: SpecNode, allEntities: SpecNode[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const fields = node.attributes.fields
  if (!isPlainObject(fields)) {
    diagnostics.push(
      diag(
        "INVALID_FIELD_DEFINITION",
        "error",
        `Entity "${node.name}" must define a fields object.`,
        { nodeId: node.id },
      ),
    )
    return diagnostics
  }
  const entityNames = new Set(allEntities.map((e) => e.name).filter(Boolean) as string[])
  const seenFields = new Set<string>()
  for (const fieldName of Object.keys(fields)) {
    if (seenFields.has(fieldName)) {
      diagnostics.push(
        diag("DUPLICATE_FIELD_NAME", "error", `Duplicate field name "${fieldName}".`, {
          nodeId: node.id,
          details: { entity: node.name, field: fieldName },
        }),
      )
      continue
    }
    seenFields.add(fieldName)
    const def = fields[fieldName]
    if (!isPlainObject(def) || typeof def.type !== "string") {
      diagnostics.push(
        diag(
          "INVALID_FIELD_DEFINITION",
          "error",
          `Field "${node.name}.${fieldName}" is not a valid field definition (use e.g. field.string()).`,
          { nodeId: node.id, details: { entity: node.name, field: fieldName } },
        ),
      )
      continue
    }
    if (!FIELD_TYPES.includes(def.type as never)) {
      diagnostics.push(
        diag(
          "FIELD_TYPE_UNKNOWN",
          "error",
          `Field "${node.name}.${fieldName}" has unknown type "${String(def.type)}". Supported: ${FIELD_TYPES.join(", ")}.`,
          { nodeId: node.id, details: { entity: node.name, field: fieldName, type: def.type } },
        ),
      )
      continue
    }
    if (def.type === "ref") {
      if (typeof def.target !== "string" || def.target.length === 0) {
        diagnostics.push(
          diag(
            "FIELD_REF_TARGET_INVALID",
            "error",
            `Field "${node.name}.${fieldName}" must declare a target entity (use field.ref("Target")).`,
            { nodeId: node.id, details: { entity: node.name, field: fieldName } },
          ),
        )
      } else if (!entityNames.has(def.target)) {
        diagnostics.push(
          diag(
            "FIELD_REF_TARGET_UNKNOWN",
            "error",
            `Field "${node.name}.${fieldName}" references unknown entity "${def.target}".`,
            { nodeId: node.id, details: { entity: node.name, field: fieldName, target: def.target } },
          ),
        )
      }
    }
    // Validation bounds are a closed vocabulary: min/max on int fields,
    // maxLength on string fields. They are VALIDATION (422) — semantic
    // limits belong to invariants (409), and the two must stay separable.
    const boundErrors: string[] = []
    const hasMin = def.min !== undefined
    const hasMax = def.max !== undefined
    const hasMaxLength = def.maxLength !== undefined
    if (def.type !== "int" && (hasMin || hasMax)) {
      boundErrors.push("min()/max() apply only to int fields (semantic limits belong to invariant(), which answers 409)")
    }
    if (def.type === "int") {
      for (const [key, value] of [["min", def.min], ["max", def.max]] as const) {
        if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value))) {
          boundErrors.push(`${key}() expects an integer`)
        }
      }
      if (
        hasMin && hasMax &&
        typeof def.min === "number" && typeof def.max === "number" && def.min > def.max
      ) {
        boundErrors.push(`min (${def.min}) must not exceed max (${def.max})`)
      }
    }
    if (hasMaxLength) {
      if (def.type !== "string") {
        boundErrors.push("maxLength() applies only to string fields")
      } else if (typeof def.maxLength !== "number" || !Number.isInteger(def.maxLength) || def.maxLength < 1) {
        boundErrors.push("maxLength() expects a positive integer")
      }
    }
    if (boundErrors.length > 0) {
      diagnostics.push(
        diag(
          "FIELD_BOUNDS_INVALID",
          "error",
          `Field "${node.name}.${fieldName}" declares invalid bounds: ${boundErrors.join("; ")}.`,
          { nodeId: node.id, details: { entity: node.name, field: fieldName } },
        ),
      )
    }
  }
  return diagnostics
}

/** CRUD resources: entity references, methods, paths. */
export const validateCrud = defineValidator("web/validate-crud", (ctx) => {
  const diagnostics: Diagnostic[] = []
  const entities = ctx.findNodes("entity")
  const entityIds = new Set(entities.map((e) => e.id))
  const entityNames = new Set(entities.map((e) => e.name).filter(Boolean) as string[])
  const seenPaths = new Map<string, SpecNode>()

  for (const node of ctx.findNodes("crud")) {
    const target = node.attributes.entity
    if (!isPlainObject(target) || typeof target.nodeId !== "string") {
      diagnostics.push(
        diag(
          "CRUD_TARGET_INVALID",
          "error",
          `CRUD resource must target an entity (crud(User)); got ${JSON.stringify(target)}.`,
          { nodeId: node.id },
        ),
      )
      continue
    }
    if (!entityIds.has(target.nodeId)) {
      diagnostics.push(
        diag(
          "CRUD_ENTITY_NOT_FOUND",
          "error",
          `CRUD resource targets "${target.nodeId}" but no such entity is defined in the specification.`,
          { nodeId: node.id, details: { entity: target.nodeId } },
        ),
      )
      continue
    }

    const path = node.attributes.path
    if (typeof path !== "string" || !/^\/[a-z0-9\-/]*$/i.test(path)) {
      diagnostics.push(
        diag(
          "CRUD_INVALID_PATH",
          "error",
          `CRUD resource for "${target.nodeId}" has invalid path ${JSON.stringify(path)} (expected e.g. "${defaultCrudPath(String(node.name ?? "Resource"))}").`,
          { nodeId: node.id, details: { path } },
        ),
      )
    } else {
      const normalized = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path
      const previous = seenPaths.get(normalized)
      if (previous) {
        diagnostics.push(
          diag(
            "CRUD_DUPLICATE_PATH",
            "error",
            `CRUD path "${normalized}" is already used by "${previous.id}".`,
            { nodeId: node.id, details: { path: normalized, firstNode: previous.id } },
          ),
        )
      } else {
        seenPaths.set(normalized, node)
      }
    }

    const methods = node.attributes.methods
    if (methods !== undefined) {
      if (!Array.isArray(methods)) {
        diagnostics.push(
          diag("CRUD_METHODS_INVALID", "error", `CRUD "methods" must be an array.`, {
            nodeId: node.id,
          }),
        )
      } else {
        const seen = new Set<string>()
        for (const method of methods) {
          if (typeof method !== "string" || !(CRUD_METHODS as readonly string[]).includes(method)) {
            diagnostics.push(
              diag(
                "CRUD_METHOD_UNKNOWN",
                "error",
                `Unknown CRUD method ${JSON.stringify(method)}. Supported: ${CRUD_METHODS.join(", ")}.`,
                { nodeId: node.id, details: { method } },
              ),
            )
          } else if (seen.has(method)) {
            diagnostics.push(
              diag("CRUD_METHOD_DUPLICATE", "error", `Duplicate CRUD method "${method}".`, {
                nodeId: node.id,
                details: { method },
              }),
            )
          } else {
            seen.add(method)
          }
        }
      }
    }

    // Cross-check: entity name consistency (crud(User) where the node was
    // renamed) — the crud node's name must match its target entity name.
    if (node.name !== undefined && entityNames.size > 0) {
      const targetEntity = entities.find((e) => e.id === target.nodeId)
      if (targetEntity && targetEntity.name !== node.name) {
        diagnostics.push(
          diag(
            "CRUD_NAME_MISMATCH",
            "warning",
            `CRUD resource is named "${node.name}" but targets entity "${targetEntity.name}".`,
            { nodeId: node.id, details: { name: node.name, entity: targetEntity.name } },
          ),
        )
      }
    }
  }
  return diagnostics
})

/** Count endpoints (api nodes with operation "count"): target entities. */
export const validateCountApis = defineValidator("web/validate-count-apis", (ctx) => {
  const diagnostics: Diagnostic[] = []
  const entityIds = new Set(ctx.findNodes("entity").map((e) => e.id))

  for (const node of ctx.findNodes("api")) {
    if (node.attributes.operation !== "count") continue
    const target = node.attributes.entity
    if (!isPlainObject(target) || typeof target.nodeId !== "string") {
      diagnostics.push(
        diag(
          "API_TARGET_INVALID",
          "error",
          `count(...) must target an entity; got ${JSON.stringify(target)}.`,
          { nodeId: node.id },
        ),
      )
      continue
    }
    if (!entityIds.has(target.nodeId)) {
      diagnostics.push(
        diag(
          "API_ENTITY_NOT_FOUND",
          "error",
          `count(...) targets "${target.nodeId}" but no such entity is defined in the specification.`,
          { nodeId: node.id, details: { entity: target.nodeId } },
        ),
      )
    }
    if (typeof node.attributes.path !== "string" || !node.attributes.path.startsWith("/")) {
      diagnostics.push(
        diag("API_INVALID_PATH", "error", `count(...) has invalid path ${JSON.stringify(node.attributes.path)}.`, {
          nodeId: node.id,
        }),
      )
    }
  }
  return diagnostics
})

/**
 * Lifecycles (docs/behavior-model.md §5): the state machine must be
 * well-formed and deterministic — a nondeterministic next-state is
 * unrepresentable, the same philosophy that rejects Date.now().
 */
export const validateLifecycles = defineValidator("web/validate-lifecycles", (ctx) => {
  const diagnostics: Diagnostic[] = []
  const entities = ctx.findNodes("entity")
  const byId = new Map(entities.map((e) => [e.id, e]))

  for (const node of ctx.findNodes("lifecycle")) {
    const targetRef = node.attributes.entity
    if (!isPlainObject(targetRef) || typeof targetRef.nodeId !== "string") {
      diagnostics.push(
        diag("LIFECYCLE_TARGET_INVALID", "error", `lifecycle(...) must target an entity.`, {
          nodeId: node.id,
        }),
      )
      continue
    }
    const entity = byId.get(targetRef.nodeId)
    if (!entity) {
      diagnostics.push(
        diag(
          "LIFECYCLE_ENTITY_NOT_FOUND",
          "error",
          `lifecycle(...) targets "${targetRef.nodeId}" but no such entity exists.`,
          { nodeId: node.id, details: { entity: targetRef.nodeId } },
        ),
      )
      continue
    }

    const fieldName = node.attributes.field
    const fields = entity.attributes.fields
    const fieldDef = isPlainObject(fields) ? fields[String(fieldName)] : undefined
    if (!isPlainObject(fieldDef) || fieldDef.type !== "enum") {
      diagnostics.push(
        diag(
          "LIFECYCLE_FIELD_INVALID",
          "error",
          `lifecycle field "${String(fieldName)}" is not an enum field of entity "${entity.name}" (use field.enum(...)).`,
          { nodeId: node.id, details: { entity: entity.name, field: String(fieldName) } },
        ),
      )
      continue
    }
    const states = new Set(Array.isArray(fieldDef.states) ? (fieldDef.states as string[]) : [])
    const initial = node.attributes.initial
    if (typeof initial !== "string" || !states.has(initial)) {
      diagnostics.push(
        diag(
          "LIFECYCLE_INITIAL_NOT_STATE",
          "error",
          `lifecycle initial ${JSON.stringify(initial)} is not a state of ${entity.name}.${String(fieldName)} (${[...states].join(", ")}).`,
          { nodeId: node.id, details: { initial } },
        ),
      )
    }

    const transitions = node.attributes.transitions
    if (!Array.isArray(transitions) || transitions.length === 0) {
      diagnostics.push(
        diag("LIFECYCLE_NO_TRANSITIONS", "error", `lifecycle must declare at least one transition.`, {
          nodeId: node.id,
        }),
      )
      continue
    }

    // (event, from-state) → to : must be a function, never a relation
    const next = new Map<string, string>()
    const reachable = new Set<string>(typeof initial === "string" && states.has(initial) ? [initial] : [])
    const declaredEvents = new Set<string>()

    for (const raw of transitions) {
      if (!isPlainObject(raw)) continue
      const event = String(raw.event)
      const to = raw.to
      declaredEvents.add(event)
      if (typeof to !== "string" || !states.has(to)) {
        diagnostics.push(
          diag(
            "LIFECYCLE_TRANSITION_TARGET_UNKNOWN",
            "error",
            `transition "${event}" targets unknown state ${JSON.stringify(to)}.`,
            { nodeId: node.id, details: { event, to } },
          ),
        )
        continue
      }
      const fromList = Array.isArray(raw.from) ? raw.from : []
      for (const from of fromList) {
        if (typeof from !== "string" || !states.has(from)) {
          diagnostics.push(
            diag(
              "LIFECYCLE_TRANSITION_TARGET_UNKNOWN",
              "error",
              `transition "${event}" lists unknown from-state ${JSON.stringify(from)}.`,
              { nodeId: node.id, details: { event, from } },
            ),
          )
          continue
        }
        const key = `${event}|${from}`
        const previous = next.get(key)
        if (previous !== undefined && previous !== to) {
          diagnostics.push(
            diag(
              "LIFECYCLE_TRANSITION_DUPLICATE",
              "error",
              `transition "${event}" from state "${from}" has two targets ("${previous}" and "${to}") — a nondeterministic next-state is not representable.`,
              { nodeId: node.id, details: { event, from, previous, to } },
            ),
          )
        } else {
          next.set(key, to)
        }
      }
    }

    // reachability (fixpoint over declared transitions)
    let changed = true
    while (changed) {
      changed = false
      for (const [key, to] of next) {
        const from = key.split("|")[1]
        if (reachable.has(from) && !reachable.has(to)) {
          reachable.add(to)
          changed = true
        }
      }
    }
    for (const state of states) {
      if (!reachable.has(state)) {
        diagnostics.push(
          diag(
            "LIFECYCLE_STATE_UNREACHABLE",
            "warning",
            `state "${state}" of ${entity.name}.${String(fieldName)} is unreachable from the initial state.`,
            { nodeId: node.id, details: { state } },
          ),
        )
      }
    }
    void declaredEvents

    // Phase 3: guards and effects on each transition
    const entityFieldsAll = isPlainObject(fields) ? fields : {}
    for (const raw of transitions) {
      if (!isPlainObject(raw)) continue
      const event = String(raw.event)

      // guard: row-check shape over entity fields, consts and request.time
      const guard = raw.guard
      if (guard !== undefined) {
        const checkGuard = (tree: unknown, depth: number): boolean => {
          if (!isPlainObject(tree) || depth > 8) return false
          const kind = tree.__expr
          if (kind === "field") {
            const fname = String(tree.name)
            const fdef = entityFieldsAll[fname]
            if (!isPlainObject(fdef)) {
              diagnostics.push(
                diag(
                  "LIFECYCLE_GUARD_TERM_UNKNOWN",
                  "error",
                  `transition "${event}" guard references field "${fname}" which does not exist on "${entity.name}".`,
                  { nodeId: node.id, details: { field: fname } },
                ),
              )
              return false
            }
            return true
          }
          if (kind === "const" || kind === "requestTime") return true
          if (kind === "cmp" || kind === "and") {
            return (
              checkGuard(tree.left, depth + 1) && checkGuard(tree.right, depth + 1)
            )
          }
          diagnostics.push(
            diag(
              "LIFECYCLE_GUARD_SHAPE_UNSUPPORTED",
              "error",
              `transition "${event}" guard uses unsupported expression "${String(kind)}" (allowed in guards: field, const, request.time, comparisons, and).`,
              { nodeId: node.id, details: { kind: String(kind) } },
            ),
          )
          return false
        }
        checkGuard(guard, 0)
      }

      // effects: set (existing writable field, const/requestTime value)
      //          emit (event name + existing payload fields)
      const effects = raw.effects
      if (effects !== undefined && !Array.isArray(effects)) {
        diagnostics.push(
          diag("LIFECYCLE_EFFECTS_INVALID", "error", `transition "${event}" effects must be an array.`, {
            nodeId: node.id,
          }),
        )
      }
      for (const eff of Array.isArray(effects) ? effects : []) {
        if (!isPlainObject(eff)) continue
        const kind = eff.__effect
        if (kind === "set") {
          const fname = String(eff.field)
          const fdef = entityFieldsAll[fname]
          if (!isPlainObject(fdef)) {
            diagnostics.push(
              diag(
                "EFFECT_TARGET_UNKNOWN",
                "error",
                `transition "${event}" sets field "${fname}" which does not exist on "${entity.name}".`,
                { nodeId: node.id, details: { field: fname } },
              ),
            )
            continue
          }
          if (fname === "id" || fname === String(fieldName)) {
            diagnostics.push(
              diag(
                "LIFECYCLE_FIELD_IMMUTABLE",
                "error",
                `transition "${event}" effect sets "${fname}" — ids and the lifecycle state field are server-controlled; the state changes via "to".`,
                { nodeId: node.id, details: { field: fname } },
              ),
            )
            continue
          }
          const value = eff.value
          const vkind = isPlainObject(value) ? String(value.__expr) : undefined
          if (vkind !== "const" && vkind !== "requestTime") {
            diagnostics.push(
              diag(
                "EFFECT_VALUE_UNSUPPORTED",
                "error",
                `transition "${event}" sets "${fname}" to an unsupported value (use expr.const(...) or expr.request.time()).`,
                { nodeId: node.id, details: { field: fname } },
              ),
            )
          } else if (
            vkind === "requestTime" &&
            isPlainObject(fdef) &&
            fdef.type !== "datetime"
          ) {
            diagnostics.push(
              diag(
                "EFFECT_VALUE_TYPE_MISMATCH",
                "error",
                `transition "${event}" sets "${fname}" (${String(fdef.type)}) to request.time() — only datetime fields accept the clock.`,
                { nodeId: node.id, details: { field: fname } },
              ),
            )
          }
        } else if (kind === "emit") {
          for (const pf of Array.isArray(eff.fields) ? eff.fields : []) {
            if (!isPlainObject(entityFieldsAll[String(pf)])) {
              diagnostics.push(
                diag(
                  "EFFECT_PAYLOAD_FIELD_UNKNOWN",
                  "error",
                  `transition "${event}" emits field "${String(pf)}" which does not exist on "${entity.name}".`,
                  { nodeId: node.id, details: { field: String(pf) } },
                ),
              )
            }
          }
        } else {
          diagnostics.push(
            diag(
              "EFFECT_KIND_UNKNOWN",
              "error",
              `transition "${event}" uses unknown effect "${String(kind)}" (supported: set, emit).`,
              { nodeId: node.id, details: { kind: String(kind) } },
            ),
          )
        }
      }
    }
  }
  return diagnostics
})

/**
 * Invariants (docs/behavior-model.md §5): the check must be an expression
 * tree from the closed vocabulary, every term must resolve, and the shape
 * must be one Phase 2 can lower (rowCheck or crossRowCount) — anything
 * richer is rejected rather than silently re-interpreted by the agent.
 */
export const validateInvariants = defineValidator("web/validate-invariants", (ctx) => {
  const diagnostics: Diagnostic[] = []
  const entities = ctx.findNodes("entity")
  const byId = new Map(entities.map((e) => [e.id, e]))
  const entityFields = (entityName: string): Record<string, unknown> => {
    const e = entities.find((x) => x.name === entityName)
    const fields = e?.attributes.fields
    return isPlainObject(fields) ? fields : {}
  }

  for (const node of ctx.findNodes("invariant")) {
    const onRef = node.attributes.on
    if (!isPlainObject(onRef) || typeof onRef.nodeId !== "string") {
      diagnostics.push(
        diag("INVARIANT_TARGET_INVALID", "error", `invariant(...) must declare an "on" entity.`, {
          nodeId: node.id,
        }),
      )
      continue
    }
    const on = byId.get(onRef.nodeId)
    if (!on || on.kind !== "entity") {
      diagnostics.push(
        diag(
          "INVARIANT_ENTITY_NOT_FOUND",
          "error",
          `invariant "${node.name}" is on "${onRef.nodeId}" but no such entity exists.`,
          { nodeId: node.id, details: { entity: onRef.nodeId } },
        ),
      )
      continue
    }
    const onName = on.name ?? ""
    const fields = entityFields(onName)
    const check = node.attributes.check
    if (!isPlainObject(check) || typeof check.__expr !== "string") {
      diagnostics.push(
        diag(
          "INVARIANT_CHECK_INVALID",
          "error",
          `invariant "${node.name}" check must be an expression from expr.* (got ${JSON.stringify(check)?.slice(0, 60)}…).`,
          { nodeId: node.id },
        ),
      )
      continue
    }

    /** Validate a rowCheck subtree: fields/consts only, no countOf. */
    const validateRowTerms = (tree: Record<string, unknown>, depth = 0): boolean => {
      if (depth > 8) return false
      const kind = tree.__expr
      if (kind === "field") {
        const name = String(tree.name)
        const def = fields[name]
        if (!isPlainObject(def)) {
          diagnostics.push(
            diag(
              "INVARIANT_TERM_UNKNOWN",
              "error",
              `invariant "${node.name}" references field "${name}" which does not exist on entity "${onName}".`,
              { nodeId: node.id, details: { field: name } },
            ),
          )
          return false
        }
        return true
      }
      if (kind === "const") return true
      if (kind === "cmp") {
        return (
          validateRowTerms(tree.left as Record<string, unknown>, depth + 1) &&
          validateRowTerms(tree.right as Record<string, unknown>, depth + 1)
        )
      }
      if (kind === "and") {
        return (
          validateRowTerms(tree.left as Record<string, unknown>, depth + 1) &&
          validateRowTerms(tree.right as Record<string, unknown>, depth + 1)
        )
      }
      diagnostics.push(
        diag(
          "INVARIANT_SHAPE_UNSUPPORTED",
          "error",
          `invariant "${node.name}" uses unsupported expression "${String(kind)}" in a row check (allowed: field, const, comparisons, and).`,
          { nodeId: node.id, details: { kind: String(kind) } },
        ),
      )
      return false
    }

    if (check.__expr === "cmp" && isPlainObject(check.left) && check.left.__expr === "countOf") {
      // crossRowCount: countOf(ref edge) <op> bound, upper bounds only
      const op = String(check.op)
      if (!["lt", "lte"].includes(op)) {
        diagnostics.push(
          diag(
            "INVARIANT_SHAPE_UNSUPPORTED",
            "error",
            `invariant "${node.name}": count comparisons support lt/lte only in this phase (got "${op}").`,
            { nodeId: node.id, details: { op } },
          ),
        )
        continue
      }
      const counted = String((check.left as Record<string, unknown>).entity)
      const countedEntity = entities.find((e) => e.name === counted)
      if (!countedEntity) {
        diagnostics.push(
          diag(
            "INVARIANT_TERM_UNKNOWN",
            "error",
            `invariant "${node.name}" counts entity "${counted}" which does not exist.`,
            { nodeId: node.id, details: { entity: counted } },
          ),
        )
        continue
      }
      const filter = (check.left as Record<string, unknown>).filter
      const entries = isPlainObject(filter) ? Object.entries(filter) : []
      if (entries.length !== 1 || entries[0][1] !== "self") {
        diagnostics.push(
          diag(
            "INVARIANT_SHAPE_UNSUPPORTED",
            "error",
            `invariant "${node.name}": countOf filter must be exactly one ref field mapped to "self".`,
            { nodeId: node.id },
          ),
        )
        continue
      }
      const [refField] = entries[0]
      const refDef = entityFields(counted)[refField]
      const refTarget = isPlainObject(refDef) ? String(refDef.target) : undefined
      if (!isPlainObject(refDef) || refDef.type !== "ref" || refTarget !== onName) {
        diagnostics.push(
          diag(
            "INVARIANT_TERM_UNKNOWN",
            "error",
            `invariant "${node.name}": "${counted}.${refField}" must be a ref field targeting "${onName}".`,
            { nodeId: node.id, details: { entity: counted, field: refField } },
          ),
        )
        continue
      }
      // the bound must be a numeric field of `on` or a numeric const
      const right = check.right
      if (isPlainObject(right) && right.__expr === "field") {
        const def = fields[String(right.name)]
        if (!isPlainObject(def) || def.type !== "int") {
          diagnostics.push(
            diag(
              "INVARIANT_TERM_UNKNOWN",
              "error",
              `invariant "${node.name}": count bound must be an int field of "${onName}" (got "${String(right.name)}").`,
              { nodeId: node.id, details: { field: String(right.name) } },
            ),
          )
        }
      } else if (!(isPlainObject(right) && right.__expr === "const" && typeof right.value === "number")) {
        diagnostics.push(
          diag(
            "INVARIANT_SHAPE_UNSUPPORTED",
            "error",
            `invariant "${node.name}": count bound must be expr.field(<int field>) or expr.const(<number>).`,
            { nodeId: node.id },
          ),
        )
      }
    } else {
      // row-local check
      validateRowTerms(check)
    }
  }
  return diagnostics
})
