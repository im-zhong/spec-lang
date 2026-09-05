/**
 * Cross-shot snapshot helpers — the equality half of the golden rule.
 *
 * These are the compiler-owned captures the GitHub generation flow runs in
 * every shot repository: a deterministic OpenAPI interface snapshot and
 * the behavior snapshot, each normalized so agent naming choices
 * (operationId, tags, descriptions) cannot create false divergence.
 */

/**
 * Deterministic OpenAPI snapshot: run inside a workspace, prints a
 * canonical JSON of paths/methods/statuses/params/body-required. The
 * agent's naming choices are ignored by construction — only
 * client-observable interface facts are kept.
 */
export const OPENAPI_SNIPPET = `import json
from app.main import app
spec = app.openapi()
norm = {}
for path, ops in spec.get("paths", {}).items():
    for method, op in ops.items():
        if method not in ("get", "post", "put", "patch", "delete"):
            continue
        norm[f"{method.upper()} {path}"] = {
            "statuses": sorted(op.get("responses", {}).keys()),
            "pathParams": sorted(p["name"] for p in op.get("parameters", []) if p.get("in") == "path"),
            "requestBody": bool(op.get("requestBody", {}).get("required", False)),
        }
print(json.dumps(norm, sort_keys=True, indent=2))
`

/** Canonicalize captured JSON (strips trailing non-JSON noise). */
export function normalizeJson(output: string): string | null {
  const start = output.indexOf("{")
  const end = output.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    return JSON.stringify(JSON.parse(output.slice(start, end + 1)))
  } catch {
    return null
  }
}
