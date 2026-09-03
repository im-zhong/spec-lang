import { defineApp, spec } from "@spec/core"

const Media = spec.interface("Media", {
  protocol: "http-json",
  version: "2",
  operations: {
    list: {
      input: { cursor: "string?" },
      output: { items: [{ id: "uuid", title: "string", duration: "int" }], next: "string?" },
      errors: { unavailable: 503 },
      transport: { method: "GET", path: "/media" },
    },
  },
})

const Backend = spec.module("backend", {
  target: "fastapi",
  provides: [Media],
})

const Frontend = spec.module("frontend", {
  target: "react",
  calls: [spec.call(Media, "list")],
})

export default defineApp({
  name: "InterfaceParallel",
  modules: [Backend, Frontend],
})
