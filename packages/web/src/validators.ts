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
  }
  return diagnostics
})
