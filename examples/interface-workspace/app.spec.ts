import { defineApp, spec } from "@spec/core"
import { entity, field, crud } from "@spec/web"
import { postgres } from "@spec/postgres"
import { fastapi } from "@spec/fastapi"
import { frontend, screen, ui } from "@spec/ui"
import { react } from "@spec/react"

const MediaApi = spec.interface("MediaApi", {
  protocol: "http-json",
  version: "1",
  operations: {
    list: {
      output: { items: [{ id: "uuid", title: "string" }] },
      errors: { unavailable: { status: 503, body: { detail: "Unavailable" } } },
      transport: { method: "GET", path: "/medias" },
    },
  },
})

const Media = entity("Media", {
  id: field.uuid(),
  title: field.string(),
})
const MediaCrud = crud(Media, { methods: ["list", "get"] })
const Database = postgres({ entities: [Media] })
const Api = fastapi({ title: "Media API", services: [MediaCrud], resources: [Database] })

const Home = screen("Home", {
  path: "/",
  title: "Media",
  body: ui.stack({ children: [ui.heading("Media"), ui.text("Browse the media catalog.")] }),
})
const Web = frontend({ title: "Media", screens: [Home] })
const Browser = react({ frontend: Web, port: 4173 })

const Backend = spec.module("backend", {
  target: "fastapi",
  provides: [MediaApi],
  contains: [Media, MediaCrud, Database, Api],
})
const Frontend = spec.module("frontend", {
  target: "react",
  calls: [spec.call(MediaApi, "list")],
  contains: [Home, Web, Browser],
})

export default defineApp({
  name: "InterfaceWorkspace",
  entities: [Media],
  services: [MediaCrud],
  resources: [Database, Api, Web, Browser],
  modules: [Backend, Frontend],
})
