import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { compile } from "@spec/compiler"
import { isSafeNonRootOciUser, lowerContainers } from "../src"

const ENTRY = "examples/container-contract/app.spec.ts"

describe("@spec/container", () => {
  it("compiles generic backend and frontend container contracts into deterministic IR", async () => {
    const first = await compile(ENTRY, { projectRoot: process.cwd() })
    const second = await compile(ENTRY, { projectRoot: process.cwd() })

    expect(first.ok).toBe(true)
    expect(first.ir).toEqual(second.ir)
    expect(first.ir.packages.map((pkg) => pkg.name)).toContain("@spec/container")

    const utility = first.ir.nodes.find((node) => node.id === "container:UtilityImage")
    expect(utility?.attributes).toMatchObject({
      profile: "generic",
      service: { nodeId: "fastapi:Utility" },
      port: 9000,
    })

    const api = first.ir.nodes.find((node) => node.id === "backend-container:ApiImage")
    expect(api?.attributes).toMatchObject({
      profile: "backend",
      service: { nodeId: "fastapi:Server" },
      platform: "linux/amd64",
      user: "10001:10001",
      port: 8000,
      readOnlyRootFilesystem: true,
      init: true,
      stopSignal: "SIGTERM",
    })
    expect(api?.attributes.command).toEqual([
      "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000",
    ])

    const web = first.ir.nodes.find((node) => node.id === "frontend-container:WebImage")
    expect(web?.attributes).toMatchObject({
      profile: "frontend",
      service: { nodeId: "react:Browser" },
      outputDirectory: "dist",
      spaFallback: true,
      port: 8080,
    })
  })

  it("rejects mutable image tags", async () => {
    const source = fs.readFileSync(ENTRY, "utf8")
    const temporary = path.join("examples/container-contract", ".tmp-mutable-image.spec.ts")
    fs.writeFileSync(
      temporary,
      source.replace(
        "registry.example.com/python-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "python:3.13-slim",
      ),
      "utf8",
    )
    try {
      const result = await compile(temporary, { projectRoot: process.cwd() })
      expect(result.ok).toBe(false)
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("CONTAINER_IMAGE_NOT_IMMUTABLE")
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  })

  it("rejects root users in every OCI user:group spelling", () => {
    for (const user of ["root", "0", "root:root", "root:1000", "1000:root", "0:1000", "1000:0"]) {
      expect(isSafeNonRootOciUser(user), user).toBe(false)
    }
    expect(isSafeNonRootOciUser("10001:10001")).toBe(true)
    expect(isSafeNonRootOciUser("app:app")).toBe(true)
  })

  it("lowers all profiles into byte-stable OCI artifacts and runtime contracts", async () => {
    const compilation = await compile(ENTRY, { projectRoot: process.cwd() })
    expect(compilation.ok).toBe(true)

    const first = lowerContainers(compilation.ir)
    const second = lowerContainers({ ...compilation.ir, nodes: [...compilation.ir.nodes].reverse() })
    expect(first).toEqual(second)
    expect(first.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(first.containers.map((container) => container.profile)).toEqual(["backend", "generic", "frontend"])

    const backend = first.containers.find((container) => container.nodeId === "backend-container:ApiImage")!
    expect(backend.files[backend.dockerfilePath]).toContain(
      "FROM --platform=linux/amd64 registry.example.com/python-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS runtime",
    )
    expect(backend.files[backend.dockerfilePath]).toContain('COPY --chown=10001:10001 [".", "."]')
    expect(backend.files[backend.dockerfilePath]).toContain('RUN ["python","-m","pip","install","--no-cache-dir","."]')
    expect(backend.files[backend.dockerfilePath]).toContain('CMD ["uvicorn","app.main:app","--host","0.0.0.0","--port","8000"]')
    expect(backend.runtime).toMatchObject({
      profile: "backend",
      serviceNodeId: "fastapi:Server",
      user: "10001:10001",
      readOnlyRootFilesystem: true,
      labels: {
        static: { "io.spec.node-id": "backend-container:ApiImage" },
        requiredNonEmpty: ["io.spec.source-revision", "io.spec.task-id"],
      },
      attestations: { sbom: true, provenance: true },
    })
    expect(backend.runtime.healthcheck?.command).toEqual(["CMD", "python", "-c", "import app.main"])

    const generic = first.containers.find((container) => container.nodeId === "container:UtilityImage")!
    expect(generic.files[generic.dockerfilePath]).not.toContain('COPY [".", "."]')
    expect(generic.runtime.command).toEqual(["python", "-m", "app.utility"])

    const frontend = first.containers.find((container) => container.nodeId === "frontend-container:WebImage")!
    const frontendDockerfile = frontend.files[frontend.dockerfilePath]
    expect(frontendDockerfile).toContain(" AS build\n")
    expect(frontendDockerfile).toContain(" AS runtime\n")
    expect(frontendDockerfile).toContain('COPY ["package.json","pnpm-lock.yaml","./"]')
    expect(frontendDockerfile).toContain('RUN ["pnpm","install","--frozen-lockfile"]')
    expect(frontendDockerfile).toContain('RUN ["pnpm","build"]')
    expect(frontendDockerfile).toContain("COPY --from=build --chown=10001:10001")
    expect(frontendDockerfile).toContain('"/usr/share/nginx/html/"')
    expect(frontend.files[`.spec/container/${frontend.slug}/nginx.conf`]).toContain("try_files $uri $uri/ /index.html")
    expect(frontend.runtime.frontend).toEqual({
      outputDirectory: "dist",
      spaFallback: true,
      staticServer: "nginx",
      documentRoot: "/usr/share/nginx/html",
    })

    expect(first.files[".dockerignore"]).toContain("**/node_modules\n")
    expect(JSON.parse(first.files[backend.contextManifestPath])).toMatchObject({
      context: ".",
      dockerignore: ".dockerignore",
      requiredBuildArguments: ["SPEC_SOURCE_REVISION", "SPEC_TASK_ID"],
    })
    expect(JSON.parse(first.files[frontend.contextManifestPath]).sourceNodes).toEqual([
      "frontend-container:WebImage",
      "frontend:Client",
      "react:Browser",
      "screen:Home",
    ])

    const changed = structuredClone(compilation.ir)
    changed.nodes.find((node) => node.id === "fastapi:Server")!.attributes.title = "Changed API"
    expect(lowerContainers(changed).fingerprint).not.toBe(first.fingerprint)
  })

  it("emits compiler-owned config and lifecycle verification for every image", async () => {
    const compilation = await compile(ENTRY, { projectRoot: process.cwd() })
    const plan = lowerContainers(compilation.ir)

    for (const container of plan.containers) {
      expect(container.verification.requiredEnvironment).toEqual(["SPEC_SOURCE_REVISION", "SPEC_TASK_ID"])
      expect(container.verification.setup).toHaveLength(2)
      expect(container.verification.setup[0].command).toContain("docker buildx build")
      expect(container.verification.setup[0].command).toContain("--sbom=true --provenance=mode=max")
      expect(container.verification.setup[0].command).toContain("type=oci,dest=")
      expect(container.verification.check.map((command) => command.name)).toEqual([
        `attestations:${container.slug}`,
        `config:${container.slug}`,
        `runtime:${container.slug}`,
      ])
      const tests = Object.entries(container.verification.tests)
      expect(tests).toHaveLength(3)
      expect(tests.every(([file]) => firstPathIsCompilerOwned(file))).toBe(true)
      expect(tests.map(([, source]) => source).join("\n")).toContain('spawnSync("docker"')
      expect(tests.map(([file]) => plan.files[file])).toEqual(tests.map(([, source]) => source))
    }
  })
})

function firstPathIsCompilerOwned(file: string): boolean {
  return /^\.spec\/container\/[a-z0-9-]+\/verify-(attestations|config|runtime)\.mjs$/.test(file)
}
