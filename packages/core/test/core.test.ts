import { describe, expect, it } from "vitest"
import {
  constraint,
  defineApp,
  isFieldRef,
  isNodeBuilder,
  nodeId,
  ref,
  serializeValue,
  fieldRef,
  toReference,
} from "../src"

describe("@spec/core types and DSL", () => {
  it("defineApp produces an app node builder", () => {
    const app = defineApp({ name: "Demo" })
    expect(isNodeBuilder(app)).toBe(true)
    expect(app.kind).toBe("app")
    expect(app.package).toBe("@spec/core")
    expect(app.attributes.name).toBe("Demo")
  })

  it("defineApp collects entity collections as children and name lists", () => {
    const app = defineApp({ name: "Demo", entities: [], services: [], resources: [] })
    expect(app.children).toEqual([])
    expect(app.attributes.entities).toEqual([])
  })

  it("defineApp rejects non-node collections", () => {
    expect(() =>
      defineApp({ name: "Demo", entities: [{ not: "a node" }] as never }),
    ).toThrow(TypeError)
  })

  it("ref() creates references by node id", () => {
    expect(ref("entity:User")).toEqual({ nodeId: "entity:User" })
    expect(ref({ kind: "entity", name: "User" })).toEqual({ nodeId: "entity:User" })
  })

  it("constraint() carries kind, value and message", () => {
    expect(constraint("max-length", 10, "short")).toEqual({
      kind: "max-length",
      value: 10,
      message: "short",
    })
  })

  it("nodeId is deterministic", () => {
    expect(nodeId("entity", "User")).toBe("entity:User")
    expect(nodeId("entity", "User")).toBe(nodeId("entity", "User"))
  })

  it("toReference derives node ids from kind+name", () => {
    const app = defineApp({ name: "Demo" })
    expect(toReference(app)).toEqual({ nodeId: "app:Demo" })
  })

  it("fieldRef markers are recognized", () => {
    const f = fieldRef("User", "email", "entity:User", true)
    expect(isFieldRef(f)).toBe(true)
    expect(isFieldRef({})).toBe(false)
  })

  it("serializeValue is key-sorted, drops functions and flattens field specs", () => {
    const value = {
      b: 1,
      a: { y: [1, 2], x: "s" },
      fn: () => 1,
      f: { __specFieldSpec: true, type: "email", uniqueFlag: true, unique: () => 1 },
    }
    expect(JSON.stringify(serializeValue(value))).toBe(
      JSON.stringify({ a: { x: "s", y: [1, 2] }, b: 1, f: { type: "email", unique: true } }),
    )
  })
})
