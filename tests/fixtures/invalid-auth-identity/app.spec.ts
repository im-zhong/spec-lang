import { defineApp } from "@spec/core"

import { entity, field } from "@spec/web"

import { auth, password } from "@spec/auth"

import { postgres } from "@spec/postgres"

const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
})

const Product = entity("Product", {
  id: field.uuid(),
})

const MainAuth = auth({
  principal: User,

  strategy: password({
    identity: Product.fields.id,
  }),
})

const MainDB = postgres({
  entities: [User, Product],
})

export default defineApp({
  name: "BadIdentityApp",

  entities: [User, Product],

  services: [MainAuth],

  resources: [MainDB],
})
