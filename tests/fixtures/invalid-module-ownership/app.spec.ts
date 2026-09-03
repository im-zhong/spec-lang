import { defineApp, spec } from "@spec/core"
import { entity, field } from "@spec/web"

const Shared = entity("Shared", { id: field.uuid() })
const Unowned = entity("Unowned", { id: field.uuid() })

const First = spec.module("first", { target: "fastapi", contains: [Shared] })
const Second = spec.module("second", { target: "fastapi", contains: [Shared] })

export default defineApp({
  name: "InvalidModuleOwnership",
  entities: [Shared, Unowned],
  modules: [First, Second],
})
