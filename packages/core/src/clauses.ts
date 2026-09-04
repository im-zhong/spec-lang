import type { ContractClause, NodeClauseTable } from "./types"

/**
 * Deterministic clause id from stable identifier parts. Parts join with
 * ":"; a part that already spans an identifier with structure of its own
 * (for example a route id like "POST /api/posts") is kept verbatim:
 * clauseId("route", "POST /api/posts") => "route:POST /api/posts".
 */
export function clauseId(...parts: string[]): string {
  if (parts.length === 0) throw new Error("clause id requires at least one part")
  for (const part of parts) {
    if (!part.trim()) throw new Error(`clause id part cannot be empty: ${JSON.stringify(parts)}`)
  }
  return parts.join(":")
}

/**
 * Stamp a clause table for one generation node: clauses sorted by id with
 * (node, id) uniqueness enforced, so the table is byte-stable under
 * stableStringify no matter the derivation order.
 */
export function clauseTable(node: string, clauses: ContractClause[]): NodeClauseTable {
  if (!node.trim()) throw new Error("clause table requires a non-empty node id")
  const seen = new Set<string>()
  for (const clause of clauses) {
    if (clause.node !== node) {
      throw new Error(`clause ${clause.id} declares node ${JSON.stringify(clause.node)} inside table for ${JSON.stringify(node)}`)
    }
    if (!clause.id.trim()) throw new Error(`clause table for ${node} contains an empty clause id`)
    if (!clause.statement.trim()) throw new Error(`clause ${clause.id} has an empty statement`)
    if (seen.has(clause.id)) throw new Error(`clause table for ${node} contains duplicate id ${clause.id}`)
    seen.add(clause.id)
  }
  return {
    schemaVersion: "spec-clause-table/0.1",
    node,
    clauses: [...clauses].sort((left, right) => left.id.localeCompare(right.id)),
  }
}
