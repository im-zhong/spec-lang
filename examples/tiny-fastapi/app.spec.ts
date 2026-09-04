import { defineApp } from "@spec/core"
import { fastapi } from "@spec/fastapi"

const Server = fastapi({
  title: "Tiny API",
  services: [],
})

export default defineApp({
  name: "TinyAPI",
  resources: [Server],
})
