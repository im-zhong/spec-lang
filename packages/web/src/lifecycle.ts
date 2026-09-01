/**
 * Lifecycle vocabulary — the "line" facet of behavior
 * (docs/behavior-model.md §2): which operations are legal WHEN.
 *
 *   lifecycle(Booking, {
 *     field: "status",                       // an enum field of Booking
 *     initial: "pending",
 *     transitions: [
 *       transition("confirm", { from: ["pending"], to: "confirmed" }),
 *       transition("cancel",  { from: ["pending", "confirmed"], to: "cancelled" }),
 *     ],
 *   })
 *
 * A transition is an OPERATION, not prose: backend targets lower it to an
 * action endpoint (POST /bookings/{id}/confirm) backed by an atomic
 * guarded update, with the failure status pinned. Everything here is
 * plain data — statically validated (LIFECYCLE_* diagnostics),
 * deterministically serializable, mechanically testable.
 */
import {
  isNodeBuilder,
  nodeBuilder,
  serializeValue,
  toReference,
  type SpecNodeBuilder,
} from "@spec/core"
import { isExprNode, stripExpr } from "./expr"
import { isEffectSpec } from "./effects"

export interface TransitionInput {
  /** States the row must currently be in (any of). */
  from: string[]
  /** The state the transition moves the row to. */
  to: string
  /** Extra predicate beyond the state guard (closed expr vocabulary;
   * may use expr.request.time()). Fails like the state guard: pinned 409. */
  guard?: unknown
  /** Causal tail: effect.set / effect.emit, declared order. */
  effects?: unknown[]
  [key: string]: unknown
}

export interface TransitionSpec {
  event: string
  from: string[]
  to: string
  guard?: unknown
  effects?: unknown[]
}

/** One named state change: `transition("confirm", { from, to, guard?, effects? })`. */
export function transition(event: string, input: TransitionInput): TransitionSpec {
  return {
    event,
    from: Array.isArray(input?.from) ? [...input.from] : [],
    to: input?.to,
    ...(isExprNode(input?.guard) ? { guard: stripExpr(input.guard) } : {}),
    ...(Array.isArray(input?.effects)
      ? {
          effects: input.effects
            .filter(isEffectSpec)
            .map((eff) =>
              eff.__effect === "set" ? { ...eff, value: stripExpr(eff.value) } : eff,
            ),
        }
      : {}),
  }
}

export interface LifecycleInput {
  /** The enum field the state machine drives. */
  field: string
  /** State assigned on create. */
  initial: string
  /** The state machine's edges. */
  transitions: TransitionSpec[]
  [key: string]: unknown
}

export function isLifecycleBuilder(value: unknown): value is SpecNodeBuilder {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__specNodeBuilder === true &&
    (value as SpecNodeBuilder).kind === "lifecycle"
  )
}

export function lifecycle(target: unknown, input: LifecycleInput): SpecNodeBuilder {
  const attributes: Record<string, unknown> = {
    field: input?.field,
    initial: input?.initial,
    transitions: (Array.isArray(input?.transitions) ? input.transitions : []).map((t) =>
      serializeValue(t),
    ),
  }

  if (isNodeBuilder(target) && target.name !== undefined) {
    attributes.entity = toReference(target)
  } else {
    attributes.entity = serializeValue(target)
  }

  const entityName = isNodeBuilder(target) && typeof target.name === "string" ? target.name : undefined
  return nodeBuilder("@spec/web", "lifecycle", entityName !== undefined ? `${entityName}Lifecycle` : undefined, attributes)
}
