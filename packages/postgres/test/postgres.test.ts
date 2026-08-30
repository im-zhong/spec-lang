import { describe, expect, it } from "vitest"
import { entity, field } from "@spec/web"
import { postgres, postgresPackage } from "../src"

describe("@spec/postgres", () => {
  it("postgres() describes a resource with entity references", () => {
    const User = entity("User", { id: field.uuid() })
    const MainDB = postgres({ entities: [User] })
    expect(MainDB.kind).toBe("postgres")
    expect(MainDB.package).toBe("@spec/postgres")
    expect(MainDB.attributes.entities).toEqual([{ nodeId: "entity:User" }])
    expect(MainDB.attributes.provides).toEqual(["RelationalStore"])
  })

  it("the package provides RelationalStore", () => {
    expect(postgresPackage.name).toBe("@spec/postgres")
    expect(postgresPackage.capabilities).toEqual([
      { name: "RelationalStore", package: "@spec/postgres" },
    ])
  })
})
