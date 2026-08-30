import { describe, expect, it } from "vitest"
import { entity, field } from "@spec/web"
import { auth, password, validateAuth, authPackage } from "../src"

describe("@spec/auth builders", () => {
  const User = entity("User", { email: field.email().unique() })

  it("auth stores a principal reference and a password strategy child", () => {
    const MainAuth = auth({
      principal: User,
      strategy: password({ identity: User.fields.email }),
    })
    MainAuth.name = "MainAuth"
    expect(MainAuth.kind).toBe("auth")
    expect(MainAuth.attributes.principal).toEqual({ nodeId: "entity:User" })
    expect(MainAuth.attributes.requires).toEqual(["RelationalStore"])
    expect(MainAuth.children).toHaveLength(1)
    expect(MainAuth.children![0].kind).toBe("passwordStrategy")
    expect(MainAuth.children![0].attributes.identity).toMatchObject({
      entity: "User",
      field: "email",
    })
  })

  it("invalid principals are kept as data for the validator", () => {
    const MainAuth = auth({ principal: "User" as never })
    expect(MainAuth.attributes.principal).toBe("User")
  })

  it("the package requires RelationalStore and registers validators", () => {
    expect(authPackage.name).toBe("@spec/auth")
    expect(authPackage.metadata?.requires).toEqual(["RelationalStore"])
    expect(validateAuth.name).toBe("auth/validate-auth")
  })
})
