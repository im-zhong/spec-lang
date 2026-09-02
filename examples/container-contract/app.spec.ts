import { defineApp } from "@spec/core"
import { backendContainer, container, frontendContainer } from "@spec/container"
import { fastapi } from "@spec/fastapi"
import { react } from "@spec/react"
import { frontend, screen, ui } from "@spec/ui"

const Server = fastapi({
  title: "Container Contract API",
  port: 8000,
  services: [],
})

const Home = screen("Home", {
  path: "/",
  title: "Home",
  body: ui.text("Container contract"),
})

const Client = frontend({
  title: "Container Contract",
  screens: [Home],
})

const Browser = react({
  frontend: Client,
  port: 4173,
})

const Utility = fastapi({
  title: "Utility API",
  port: 9000,
  services: [],
})

const UtilityImage = container("UtilityImage", {
  service: Utility,
  baseImage: "registry.example.com/utility@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  port: 9000,
  command: ["python", "-m", "app.utility"],
})

const ApiImage = backendContainer("ApiImage", {
  service: Server,
  baseImage: "registry.example.com/python-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  port: 8000,
  healthcheck: {
    command: ["CMD", "python", "-c", "import app.main"],
    intervalSeconds: 30,
    timeoutSeconds: 3,
    retries: 3,
  },
})

const WebImage = frontendContainer("WebImage", {
  service: Browser,
  buildImage: "registry.example.com/node-builder@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  runtimeImage: "registry.example.com/static-runtime@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  port: 8080,
  spaFallback: true,
})

export default defineApp({
  name: "ContainerContract",
  resources: [Server, Client, Browser, Utility, UtilityImage, ApiImage, WebImage],
})
