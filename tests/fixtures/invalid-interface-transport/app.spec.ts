import { defineApp, spec } from "@spec/core"

const MissingTransport = spec.interface("MissingTransport", {
  protocol: "http-json",
  operations: {
    read: { output: { ok: "boolean" } },
  },
})

const Backend = spec.module("backend", {
  target: "fastapi",
  provides: [MissingTransport],
})

export default defineApp({ name: "InvalidInterfaceTransport", modules: [Backend] })
