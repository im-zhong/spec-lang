import { defineApp } from "@spec/core"

import { entity, field } from "@spec/web"

import { auth, password } from "@spec/auth"

const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
})

const MainAuth = auth({
  principal: User,

  strategy: password({
    identity: User.fields.email,
  }),
})

export default defineApp({
  name: "NoDatabaseApp",

  entities: [User],

  services: [MainAuth],
})
