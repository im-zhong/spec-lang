import { defineApp } from "@spec/core"

import { entity, field } from "@spec/web"

const User = entity("User", {
  id: field.uuid(),
})

const total = (() => 42)()

for (const item of [1, 2, 3]) {
  console.log(item)
}

export default defineApp({
  name: "UnsupportedSyntaxApp",

  entities: [User],
})
