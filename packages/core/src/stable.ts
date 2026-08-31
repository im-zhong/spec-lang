/**
 * Deterministic JSON serialization: object keys sorted recursively,
 * fixed indentation, no incidental formatting.
 *
 * Same (spec source + package versions + compiler version) MUST produce
 * byte-identical output. Never feed nondeterministic values (timestamps,
 * random ids) into anything that goes through here.
 */
export function stableStringify(value: unknown): string {
  return serialize(value, 0)
}

function serialize(value: unknown, depth: number): string {
  const indent = "  ".repeat(depth)
  const innerIndent = "  ".repeat(depth + 1)
  if (value === null) return "null"
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    const items = value.map((item) => serialize(item, depth + 1))
    return "[\n" + items.map((item) => innerIndent + item).join(",\n") + "\n" + indent + "]"
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    if (keys.length === 0) return "{}"
    const entries = keys.map(
      (key) => innerIndent + JSON.stringify(key) + ": " + serialize(record[key], depth + 1),
    )
    return "{\n" + entries.join(",\n") + "\n" + indent + "}"
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`Cannot serialize non-finite number ${value} into deterministic JSON`)
  }
  return JSON.stringify(value)
}
