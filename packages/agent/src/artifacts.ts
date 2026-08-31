/**
 * Workspace artifact scanning: provenance for generated code.
 *
 * Every file the agent wrote becomes an `Artifact` (core type) with a
 * content hash, so the Artifact → AgentTask → SpecNode → SourceLocation
 * chain promised by the architecture is actually populated.
 */
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { Artifact, ArtifactType } from "@spec/core"

const SKIP_DIRS = new Set([
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".git",
  "node_modules",
  ".spec-workspace",
])

/** Marker file written into workspaces this compiler created. */
export const MARKER_FILE = ".spec-generated"

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

function classify(relPath: string): ArtifactType {
  const base = path.basename(relPath)
  if (base.startsWith("test_") || base.endsWith("_test.py") || relPath.includes("/tests/")) {
    return "test"
  }
  if (/\.(md|rst|txt)$/i.test(base)) return "document"
  if (/\.(toml|cfg|ini|yaml|yml|env|lock)$/i.test(base)) return "config"
  if (/\.(py|ts|js|go|rs|java|sql)$/i.test(base)) return "source"
  return "document"
}

export interface ScanOptions {
  /** Directories (relative) excluded from the artifact set. */
  excludeDirs?: string[]
  generatedBy: string
  sourceNodes?: string[]
}

export function scanArtifacts(workspace: string, options: ScanOptions): Artifact[] {
  const exclude = new Set((options.excludeDirs ?? []).map((d) => d.replace(/\/$/, "")))
  const artifacts: Artifact[] = []
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === MARKER_FILE) continue
      const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || exclude.has(entryRel)) continue
        walk(path.join(dir, entry.name), entryRel)
        continue
      }
      if (!entry.isFile()) continue
      let content: Buffer
      try {
        content = fs.readFileSync(path.join(dir, entry.name))
      } catch {
        continue
      }
      artifacts.push({
        id: `artifact:${entryRel}`,
        type: classify(entryRel),
        path: entryRel,
        contentHash: sha256(content),
        generatedBy: options.generatedBy,
        sourceNodes: options.sourceNodes,
      })
    }
  }
  walk(workspace, "")
  return artifacts
}

/** Only directories carrying our marker may be wiped for regeneration. */
export function isCompilerWorkspace(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, MARKER_FILE)).isFile()
  } catch {
    return false
  }
}

export function prepareWorkspace(dir: string, force = true): { created: boolean; wiped: boolean } {
  const exists = fs.existsSync(dir)
  if (exists && fs.statSync(dir).isDirectory()) {
    const nonEmpty = fs.readdirSync(dir).length > 0
    if (nonEmpty) {
      if (!force || !isCompilerWorkspace(dir)) {
        throw new Error(
          `workspace "${dir}" is not empty and is not a compiler-generated workspace (missing ${MARKER_FILE}); refusing to overwrite`,
        )
      }
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, MARKER_FILE), `${new Date().toISOString()}\n`, "utf8")
      return { created: false, wiped: true }
    }
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, MARKER_FILE), `${new Date().toISOString()}\n`, "utf8")
  return { created: !exists, wiped: false }
}
