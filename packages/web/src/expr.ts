/**
 * The expression vocabulary for behavioral constraints
 * (docs/behavior-model.md §3).
 *
 * Every expression is a PURE DATA TREE — no closures, statically
 * evaluable by the compiler, serializable into the IR. The litmus test
 * governs admission: an expression enters this vocabulary only if it
 * lowers to a single SQL statement. Anything richer is prose wearing a
 * syntax tree and is rejected (INVARIANT_SHAPE_UNSUPPORTED).
 *
 *   expr.field("capacity")                    → column of the invariant's entity
 *   expr.const(18)                            → literal
 *   expr.countOf("Booking", { venue: "self" })→ scalar subquery over a ref edge
 *   expr.field("age").gte(expr.const(18))     → comparison
 *   comparison.and(other)                     → conjunction
 *
 * Chain methods exist only for authoring ergonomics; functions are
 * dropped by serialization, so the IR sees pure data.
 */

export type ComparisonOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte"

export interface ExprField {
  readonly __expr: "field"
  name: string
}
export interface ExprConst {
  readonly __expr: "const"
  value: unknown
}
/** count of rows of `entity` whose `filter` ref field points at the
 * invariant's own entity ("self"). */
export interface ExprCountOf {
  readonly __expr: "countOf"
  entity: string
  filter: Record<string, string>
}
/**
 * The request's receipt time — a RUNTIME term. Deliberately distinct from
 * compile-time `Date.now()` (which `SPEC_FORBIDDEN_ACCESS` rejects): no
 * timestamp is baked into the IR; the spec pins only THAT the comparison
 * happens against request receipt time (naive UTC). Allowed in
 * transition guards and effect values, never in invariants (an invariant
 * holding "at all times" cannot depend on the clock).
 */
export interface ExprRequestTime {
  readonly __expr: "requestTime"
}
export interface ExprCmp {
  readonly __expr: "cmp"
  op: ComparisonOp
  left: ExprNode
  right: ExprNode
}
export interface ExprAnd {
  readonly __expr: "and"
  left: ExprNode
  right: ExprNode
}

export type ExprNode =
  | ExprField
  | ExprConst
  | ExprCountOf
  | ExprRequestTime
  | ExprCmp
  | ExprAnd

export function isExprNode(value: unknown): value is ExprNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).__expr === "string"
  )
}

/** Comparison ops admitted for count comparisons (upper bounds only —
 * lower bounds would need delete-time checks, out of Phase 2 scope). */
export const COUNT_OPS: readonly ComparisonOp[] = ["lt", "lte"]

/** Authoring wrapper: data + chain methods (dropped on serialization). */
type Chainable<T> = T & {
  eq(other: ExprNode): ExprCmp
  neq(other: ExprNode): ExprCmp
  lt(other: ExprNode): ExprCmp
  lte(other: ExprNode): ExprCmp
  gt(other: ExprNode): ExprCmp
  gte(other: ExprNode): ExprCmp
}

function chain<T extends object>(node: T): Chainable<T> {
  const cmp = (op: ComparisonOp) => (other: ExprNode): ExprCmp => ({ __expr: "cmp", op, left: node as ExprNode, right: other })
  return {
    ...node,
    eq: cmp("eq"),
    neq: cmp("neq"),
    lt: cmp("lt"),
    lte: cmp("lte"),
    gt: cmp("gt"),
    gte: cmp("gte"),
  } as Chainable<T>
}

/** Strip chain methods recursively — the pure data an IR can carry. */
export function stripExpr(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripExpr)
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    if (typeof record.__expr === "string") {
      const out: Record<string, unknown> = {}
      for (const [key, v] of Object.entries(record)) {
        if (typeof v === "function") continue
        out[key] = stripExpr(v)
      }
      return out
    }
    return value
  }
  return value
}

export const expr = {
  /** A field of the invariant's own entity. */
  field: (name: string) => chain<ExprField>({ __expr: "field", name }),
  /** A literal constant. */
  const: (value: string | number | boolean) => ({ __expr: "const", value }) as ExprConst,
  /**
   * The request's receipt time (naive UTC) — a runtime term for guards
   * and effect values. The spec pins the comparison, never a timestamp.
   */
  request: {
    time: () => chain<ExprRequestTime>({ __expr: "requestTime" }),
  },
  /**
   * Cardinality across a `field.ref` edge: the number of `entity` rows
   * whose ref field points at the invariant's own entity.
   *   expr.countOf(Booking, { venue: "self" })
   */
  countOf: (entity: unknown, filter: Record<string, string>) =>
    chain<ExprCountOf>({
      __expr: "countOf",
      entity: typeof entity === "string" ? entity : String((entity as { name?: string })?.name ?? ""),
      filter: { ...filter },
    }),
}

/** Conjunction of two comparisons (authoring helper). */
export function both(left: ExprCmp, right: ExprNode): ExprAnd {
  return { __expr: "and", left, right }
}
