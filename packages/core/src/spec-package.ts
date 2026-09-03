import type { SpecPackage } from "./types"

/**
 * The core package itself. It registers no domain node kinds and no
 * validators — it only contributes the `app` root node and the core DSL.
 *
 * Note: core deliberately does NOT use @spec/package-sdk (the SDK sits on
 * top of core, not below it), so this is a plain SpecPackage literal.
 */
const corePackage: SpecPackage = {
  name: "@spec/core",
  version: "0.1.0",
  nodeKinds: [{ kind: "app" }, { kind: "interface" }, { kind: "module" }],
}

export default corePackage
