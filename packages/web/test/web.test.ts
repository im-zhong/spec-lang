import { describe, expect, it } from "vitest"
import { entity, field, isFieldSpec, webPackage } from "../src"

describe("@spec/web entity/field", () => {
  it("field builders produce chainable immutable specs", () => {
    const email = field.email()
    expect(isFieldSpec(email)).toBe(true)
    expect(email.type).toBe("email")
    const chained = email.unique().optional()
    expect(chained).not.toBe(email)
    expect(email.uniqueFlag).toBe(false)
    expect(chained.uniqueFlag).toBe(true)
    expect(chained.optionalFlag).toBe(true)
    expect(chained.type).toBe("email")
  })

  it("all six field types exist", () => {
    for (const t of ["string", "int", "boolean", "uuid", "email", "datetime"] as const) {
      expect(field[t]().type).toBe(t)
    }
  })

  it("entity produces an entity node with plain field attributes", () => {
    const User = entity("User", {
      id: field.uuid(),
      email: field.email().unique(),
      name: field.string(),
    })
    expect(User.kind).toBe("entity")
    expect(User.package).toBe("@spec/web")
    expect(User.name).toBe("User")
    expect(User.attributes.fields).toEqual({
      id: { type: "uuid" },
      email: { type: "email", unique: true },
      name: { type: "string" },
    })
  })

  it("entity.fields exposes typed field references", () => {
    const User = entity("User", { email: field.email().unique() })
    expect(User.fields.email).toMatchObject({
      entity: "User",
      field: "email",
      ownerNodeId: "entity:User",
      unique: true,
    })
  })

  it("invalid field definitions pass through for the validator", () => {
    const Bad = entity("Bad", { x: "not-a-field" as never })
    expect(Bad.attributes.fields).toEqual({ x: "not-a-field" })
  })

  it("the package registers validators and an entity inspector", () => {
    expect(webPackage.name).toBe("@spec/web")
    expect(webPackage.validators?.length).toBeGreaterThan(0)
    expect(webPackage.inspectors?.entity).toBeTypeOf("function")
  })
})
