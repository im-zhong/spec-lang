/**
 * Effect vocabulary — the causal tail of an operation
 * (docs/behavior-model.md Phase 3).
 *
 *   transition("cancel", {
 *     from: ["pending", "confirmed"], to: "cancelled",
 *     effects: [
 *       effect.set("cancelledAt", expr.request.time()),
 *       effect.emit("booking.cancelled", ["id", "venue", "startsAt"]),
 *     ],
 *   })
 *
 * Effects execute inside the transition's transaction, in declared
 * order, all-or-nothing. `emit` writes a row to the generated `events`
 * outbox table — event sourcing's audit benefit as plain data, without
 * its architecture.
 */
import type { ExprNode } from "./expr"

export interface EffectSet {
  readonly __effect: "set"
  field: string
  value: ExprNode
}

export interface EffectEmit {
  readonly __effect: "emit"
  event: string
  /** Entity fields carried in the payload (JSON object, pinned keys). */
  fields: string[]
}

export type EffectSpec = EffectSet | EffectEmit

export const effect = {
  /** Assign a field of the row (same transaction). */
  set: (field: string, value: ExprNode): EffectSet => ({ __effect: "set", field, value }),
  /** Append an outbox row: (id, event, payload JSON, created_at). */
  emit: (event: string, fields: string[]): EffectEmit => ({ __effect: "emit", event, fields: [...fields] }),
}

export function isEffectSpec(value: unknown): value is EffectSpec {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).__effect === "string"
  )
}
