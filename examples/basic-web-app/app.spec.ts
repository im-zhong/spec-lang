import { defineApp } from "@spec/core"

import { entity, field } from "@spec/web"

import { auth, password } from "@spec/auth"

import { postgres } from "@spec/postgres"

const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
  name: field.string(),
})

const MainAuth = auth({
  principal: User,

  strategy: password({
    identity: User.fields.email,
  }),
})

const MainDB = postgres({
  entities: [User],
})

export default defineApp({
  name: "ExampleApp",

  entities: [User],

  services: [MainAuth],

  resources: [MainDB],
})
