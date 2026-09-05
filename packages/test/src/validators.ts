/**
 * @spec/test semantics: every example must be structurally sound and
 * reference only declared vocabulary — an example is a CONTRACT, so an
 * unsatisfiable or dangling one must fail at `spec check`, never at
 * generation time.
 *
 * The expectation language is closed: body values are JSON literals,
 * "$binding" row-id references, or the predicates NOT_NULL / ANY; state
 * assertions address outbox event rows and per-table count deltas.
 */
import type { Diagnostic, SpecNode } from "@spec/core"
import { defineValidator, diag } from "@spec/package-sdk"
import { isExpectPredicate } from "./example"

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function jsonSafe(value: unknown): boolean {
  if (value === null || ["string", "boolean", "number"].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(jsonSafe)
  if (isPlainObject(value)) return Object.values(value).every(jsonSafe)
  return false
}

const BINDING_RE = /^\$[a-z][a-z0-9_]*$/
const AS_RE = /^[a-z][a-z0-9_]*$/

/** Field definitions declared by an entity node (undefined when unresolvable). */
function entityFieldDefs(entityNodeId: string | undefined, entities: SpecNode[]): Record<string, unknown> | undefined {
  if (entityNodeId === undefined) return undefined
  const node = entities.find((e) => e.id === entityNodeId)
  const fields = node?.attributes.fields
  return isPlainObject(fields) ? fields : undefined
}

export const validateExamples = defineValidator("test/validate-examples", (ctx) => {
  const diagnostics: Diagnostic[] = []
  const entities = ctx.findNodes("entity")
  const services = [...ctx.findNodes("crud"), ...ctx.findNodes("lifecycle"), ...ctx.findNodes("api")]

  for (const node of ctx.findNodes("example")) {
    const where = { nodeId: node.id }
    const label = node.name ?? node.id

    /* ---- target ---- */
    const target: unknown = node.attributes.target
    const targetRecord = isPlainObject(target) ? target : undefined
    const targetService = targetRecord !== undefined ? targetRecord.service : undefined
    if (targetRecord === undefined || typeof targetRecord.selector !== "string" || targetRecord.selector.length === 0) {
      diagnostics.push(
        diag(
          "EXAMPLE_TARGET_INVALID",
          "error",
          `Example "${label}" must target op(service, selector) — a crud method or lifecycle event.`,
          where,
        ),
      )
    } else if (!isPlainObject(targetService) || typeof targetService.nodeId !== "string") {
      diagnostics.push(
        diag(
          "EXAMPLE_TARGET_INVALID",
          "error",
          `Example "${label}" targets something other than a service node (pass the crud/lifecycle builder to op()).`,
          where,
        ),
      )
    } else if (isPlainObject(targetService) && services.every((s) => s.id !== targetService.nodeId)) {
      diagnostics.push(
        diag(
          "EXAMPLE_TARGET_UNKNOWN",
          "error",
          `Example "${label}" targets "${String(targetService.nodeId)}" which is not a crud/lifecycle/api service.`,
          { ...where, details: { target: String(targetService.nodeId) } },
        ),
      )
    }

    /* ---- given fixtures ---- */
    const given = node.attributes.given
    const bindingEntityIds = new Map<string, string>()
    if (given !== undefined && !Array.isArray(given)) {
      diagnostics.push(
        diag("EXAMPLE_GIVEN_INVALID", "error", `Example "${label}" given must be an array of fixture(...) rows.`, where),
      )
    } else if (Array.isArray(given)) {
      for (const item of given) {
        const itemEntity = isPlainObject(item) ? item.entity : undefined
        const entityRefOk = isPlainObject(itemEntity) && typeof itemEntity.nodeId === "string"
        if (
          !isPlainObject(item) ||
          typeof item.as !== "string" ||
          !AS_RE.test(item.as) ||
          !entityRefOk
        ) {
          diagnostics.push(
            diag(
              "EXAMPLE_GIVEN_INVALID",
              "error",
              `Example "${label}" has a malformed fixture — use fixture(Entity, { as: "name", fields: {...} }).`,
              where,
            ),
          )
          continue
        }
        if (bindingEntityIds.has(item.as)) {
          diagnostics.push(
            diag("EXAMPLE_BINDING_DUPLICATE", "error", `Example "${label}" reuses fixture binding "${item.as}".`, where),
          )
        }
        const entityNode = entities.find((e) => e.id === (itemEntity as { nodeId: string }).nodeId)
        if (entityNode === undefined) {
          diagnostics.push(
            diag(
              "EXAMPLE_ENTITY_UNKNOWN",
              "error",
              `Example "${label}" fixture "${item.as}" references unknown entity "${String((itemEntity as { nodeId: string }).nodeId)}".`,
              where,
            ),
          )
          continue
        }
        bindingEntityIds.set(item.as, entityNode.id)
        const defs = entityFieldDefs(entityNode.id, entities)
        if (defs !== undefined && item.fields !== undefined) {
          if (!isPlainObject(item.fields)) {
            diagnostics.push(
              diag("EXAMPLE_GIVEN_INVALID", "error", `Example "${label}" fixture "${item.as}" fields must be an object.`, where),
            )
          } else {
            for (const key of Object.keys(item.fields)) {
              if (!(key in defs)) {
                diagnostics.push(
                  diag(
                    "EXAMPLE_FIELD_UNKNOWN",
                    "error",
                    `Example "${label}" fixture "${item.as}" sets "${key}" which is not a declared field of the entity.`,
                    where,
                  ),
                )
              }
            }
          }
        }
      }
    }

    /** Validate "$binding" values against the referenced field's ref target. */
    const checkBinding = (value: string, fieldName: string, defs: Record<string, unknown> | undefined, what: string) => {
      const binding = value.slice(1)
      const boundEntityId = bindingEntityIds.get(binding)
      if (boundEntityId === undefined) {
        diagnostics.push(
          diag("EXAMPLE_BINDING_UNKNOWN", "error", `Example "${label}" ${what} references "${value}" but no fixture declares that binding.`, where),
        )
        return
      }
      const def = defs?.[fieldName]
      if (isPlainObject(def) && typeof def.target === "string" && boundEntityId !== `entity:${def.target}`) {
        diagnostics.push(
          diag(
            "EXAMPLE_BINDING_TYPE_MISMATCH",
            "error",
            `Example "${label}" ${what} binds "${fieldName}" to fixture "${binding}" of the wrong entity — the field references "${def.target}".`,
            where,
          ),
        )
      }
    }

    /* ---- subject ---- */
    const subject = node.attributes.subject
    if (subject !== undefined) {
      if (typeof subject !== "string" || !BINDING_RE.test(subject) || !bindingEntityIds.has(subject.slice(1))) {
        diagnostics.push(
          diag(
            "EXAMPLE_SUBJECT_INVALID",
            "error",
            `Example "${label}" subject must be "$<binding>" of one of its given fixtures.`,
            where,
          ),
        )
      }
    }

    /* ---- input ---- */
    const targetEntityId =
      isPlainObject(targetService) && typeof targetService.nodeId === "string"
        ? services.find((s) => s.id === targetService.nodeId)?.attributes.entity
        : undefined
    const targetDefs =
      isPlainObject(targetEntityId) && typeof targetEntityId.nodeId === "string"
        ? entityFieldDefs(targetEntityId.nodeId, entities)
        : undefined
    const input = node.attributes.input
    if (input !== undefined) {
      if (!isPlainObject(input)) {
        diagnostics.push(
          diag("EXAMPLE_INPUT_INVALID", "error", `Example "${label}" input must be a plain JSON object.`, where),
        )
      } else if (!jsonSafe(input)) {
        diagnostics.push(
          diag("EXAMPLE_INPUT_INVALID", "error", `Example "${label}" input must be JSON-serializable literals.`, where),
        )
        // Skip per-key checks when values carry builder objects.
      } else {
        for (const [key, value] of Object.entries(input)) {
          if (targetDefs !== undefined && !(key in targetDefs)) {
            diagnostics.push(
              diag(
                "EXAMPLE_FIELD_UNKNOWN",
                "error",
                `Example "${label}" input sets "${key}" which is not a declared field of the target entity.`,
                where,
              ),
            )
          }
          if (typeof value === "string" && value.startsWith("$")) {
            if (!BINDING_RE.test(value)) {
              diagnostics.push(
                diag("EXAMPLE_BINDING_INVALID", "error", `Example "${label}" input binding ${JSON.stringify(value)} must match $<fixture binding>.`, where),
              )
            } else {
              checkBinding(value, key, targetDefs, `input field "${key}"`)
            }
          }
        }
      }
    }

    /* ---- expect ---- */
    const expect: unknown = node.attributes.expect
    const expectRecord = isPlainObject(expect) ? expect : undefined
    const expectStatus = expectRecord !== undefined ? expectRecord.status : undefined
    if (expectRecord === undefined || !Number.isInteger(expectStatus) || (expectStatus as number) < 100 || (expectStatus as number) > 599) {
      diagnostics.push(
        diag(
          "EXAMPLE_EXPECT_INVALID",
          "error",
          `Example "${label}" expect must declare an integer status (100–599), e.g. expect({ status: 201, body: {...} }).`,
          where,
        ),
      )
      continue
    }
    if (expectRecord.match !== undefined && expectRecord.match !== "subset" && expectRecord.match !== "exact") {
      diagnostics.push(
        diag("EXAMPLE_EXPECT_INVALID", "error", `Example "${label}" match must be "subset" (default) or "exact".`, where),
      )
    }
    if (expectRecord.body !== undefined) {
      if (!isPlainObject(expectRecord.body)) {
        diagnostics.push(
          diag("EXAMPLE_EXPECT_INVALID", "error", `Example "${label}" expect.body must be a plain JSON object of literals (subset match).`, where),
        )
      } else {
        for (const [key, value] of Object.entries(expectRecord.body)) {
          if (isExpectPredicate(value)) continue
          if (isPlainObject(value)) {
            // The only admitted object values are the closed predicates;
            // any other marker is an unknown expectation.
            diagnostics.push(
              diag(
                "EXAMPLE_EXPECT_INVALID",
                "error",
                `Example "${label}" expect.body value for "${key}" must be a literal, $binding, NOT_NULL, or ANY.`,
                where,
              ),
            )
            continue
          }
          // Error responses are target-owned shapes (e.g. {detail}), not
          // entity Out fields — membership is only pinned for 2xx bodies.
          if (targetDefs !== undefined && (expectStatus as number) >= 200 && (expectStatus as number) < 300 && !(key in targetDefs)) {
            diagnostics.push(
              diag(
                "EXAMPLE_FIELD_UNKNOWN",
                "error",
                `Example "${label}" expect.body pins "${key}" which is not a declared field of the target entity.`,
                where,
              ),
            )
            continue
          }
          if (typeof value === "string" && value.startsWith("$")) {
            if (!BINDING_RE.test(value)) {
              diagnostics.push(
                diag("EXAMPLE_BINDING_INVALID", "error", `Example "${label}" expect.body binding ${JSON.stringify(value)} must match $<fixture binding>.`, where),
              )
            } else {
              checkBinding(value, key, targetDefs, `expect.body field "${key}"`)
            }
            continue
          }
          if (!jsonSafe(value)) {
            diagnostics.push(
              diag("EXAMPLE_EXPECT_INVALID", "error", `Example "${label}" expect.body values must be literals, $bindings, or NOT_NULL/ANY.`, where),
            )
          }
        }
      }
    }

    /* ---- state assertions (what the request did to the world) ---- */
    const state = expectRecord.state
    if (state !== undefined) {
      if (!isPlainObject(state)) {
        diagnostics.push(
          diag("EXAMPLE_STATE_INVALID", "error", `Example "${label}" state must be an object with outbox/counts arrays.`, where),
        )
        continue
      }
      for (const entry of Array.isArray(state.outbox) ? state.outbox : [undefined]) {
        if (entry === undefined) {
          if (state.outbox !== undefined) {
            diagnostics.push(
              diag("EXAMPLE_STATE_INVALID", "error", `Example "${label}" state.outbox must be an array of { event, from, fields }.`, where),
            )
          }
          continue
        }
        if (
          !isPlainObject(entry) ||
          typeof entry.event !== "string" ||
          entry.event.length === 0 ||
          typeof entry.from !== "string" ||
          !Array.isArray(entry.fields)
        ) {
          diagnostics.push(
            diag(
              "EXAMPLE_STATE_INVALID",
              "error",
              `Example "${label}" state.outbox entries must declare event, from: "$<fixture>", and a fields array.`,
              where,
            ),
          )
          continue
        }
        if (!BINDING_RE.test(entry.from) || !bindingEntityIds.has(entry.from.slice(1))) {
          diagnostics.push(
            diag("EXAMPLE_BINDING_UNKNOWN", "error", `Example "${label}" state.outbox from ${JSON.stringify(entry.from)} must be a fixture binding.`, where),
          )
          continue
        }
        const defs = entityFieldDefs(bindingEntityIds.get(entry.from.slice(1))!, entities)
        for (const field of entry.fields) {
          if (typeof field !== "string" || (defs !== undefined && !(field in defs))) {
            diagnostics.push(
              diag(
                "EXAMPLE_STATE_INVALID",
                "error",
                `Example "${label}" state.outbox field ${JSON.stringify(field)} is not a declared field of the fixture's entity.`,
                where,
              ),
            )
          }
        }
      }
      for (const entry of Array.isArray(state.counts) ? state.counts : [undefined]) {
        if (entry === undefined) {
          if (state.counts !== undefined) {
            diagnostics.push(
              diag("EXAMPLE_STATE_INVALID", "error", `Example "${label}" state.counts must be an array of { entity, delta }.`, where),
            )
          }
          continue
        }
        const entryEntity = isPlainObject(entry) ? entry.entity : undefined
        const entryEntityId = isPlainObject(entryEntity) && typeof entryEntity.nodeId === "string" ? entryEntity.nodeId : undefined
        if (
          !isPlainObject(entry) ||
          entryEntityId === undefined ||
          entities.every((e) => e.id !== entryEntityId)
        ) {
          diagnostics.push(
            diag("EXAMPLE_ENTITY_UNKNOWN", "error", `Example "${label}" state.counts entries must reference a declared entity.`, where),
          )
          continue
        }
        if (!Number.isInteger(entry.delta)) {
          diagnostics.push(
            diag("EXAMPLE_STATE_INVALID", "error", `Example "${label}" state.counts delta must be an integer (0 asserts the count is unchanged).`, where),
          )
        }
      }
    }
  }
  return diagnostics
})
