/**
 * Invariant vocabulary — the "plane" facet of behavior
 * (docs/behavior-model.md §2): what must hold across entities AT ALL
 * TIMES. "Full" is derived, never stored; the database arbitrates.
 *
 *   // cross-row: no venue may be overbooked
 *   const NoOverbooking = invariant("no-overbooking", {
 *     on: Venue,
 *     check: expr.countOf(Booking, { venue: "self" }).lte(expr.field("capacity")),
 *   })
 *
 *   // row-local: every post has a non-empty title
 *   const NoEmptyTitle = invariant("no-empty-title", {
 *     on: Post,
 *     check: expr.field("title").neq(expr.const("")),
 *   })
 *
 * Pure data: the check is an expression tree from the closed vocabulary
 * (see expr.ts), validated at compile time and lowered mechanically.
 */
import {
  isNodeBuilder,
  nodeBuilder,
  serializeValue,
  toReference,
  type SpecNodeBuilder,
} from "@spec/core"
import { isExprNode, stripExpr } from "./expr"

export interface InvariantInput {
  /** The entity the invariant is about ("self" in the check). */
  on?: unknown
  /** The boolean expression tree that must hold for every row. */
  check?: unknown
  [key: string]: unknown
}

export function invariant(name: string, input: InvariantInput): SpecNodeBuilder {
  const attributes: Record<string, unknown> = {
    check: isExprNode(input?.check) ? stripExpr(input.check) : serializeValue(input?.check),
  }
  if (isNodeBuilder(input?.on) && input.on.name !== undefined) {
    attributes.on = toReference(input.on)
  } else {
    attributes.on = serializeValue(input?.on)
  }
  return nodeBuilder("@spec/web", "invariant", name, attributes)
}
