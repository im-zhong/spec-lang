import { definePackage, defineNode, provides } from "@spec/package-sdk"

export default definePackage({
  name: "@spec/postgres",
  version: "0.1.0",
  nodeKinds: [defineNode("postgres")],
  capabilities: [provides("RelationalStore")],
  inspectors: {
    postgres: (node) => ({
      label: "PostgreSQL",
      lines: [
        `entities: ${Array.isArray(node.attributes.entities)
          ? (node.attributes.entities as unknown[])
              .map((e) =>
                e && typeof e === "object" && "nodeId" in (e as Record<string, unknown>)
                  ? String((e as { nodeId: unknown }).nodeId).split(":").slice(1).join(":")
                  : String(e),
              )
              .join(", ")
          : ""}`,
      ],
    }),
  },
})
