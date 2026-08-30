import { defineApp } from "@spec/core"

import { entity, field } from "@spec/web"

const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
})

const UserAlias = entity("User", {
  id: field.uuid(),
})

export default defineApp({
  name: "DuplicateEntityApp",

  entities: [User, UserAlias],
})
