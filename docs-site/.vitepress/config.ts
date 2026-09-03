import { defineConfig } from "vitepress"

const description =
  "Describe software in a restricted TypeScript DSL, compile it to a deterministic Spec IR, and get structured diagnostics — a stable foundation for AI-agent-driven software generation."

export default defineConfig({
  lang: "en-US",
  title: "spec",
  tagline: "Specification Programming in TypeScript",
  description,

  cleanUrls: true,

  // Bind to all interfaces (IPv4 + IPv6). Node's default `localhost`
  // binding is IPv6-only (::1), which makes http://127.0.0.1:PORT — and
  // any browser resolving localhost to 127.0.0.1 — refuse the connection.
  vite: {
    server: { host: "::" },
    preview: { host: "::" },
  },

  head: [
    ["meta", { name: "theme-color", content: "#3c8cff" }],
    ["link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
  ],

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
      { text: "Deep Dive", link: "/deep-dive/source-walkthrough", activeMatch: "/deep-dive/" },
      { text: "Reference", link: "/reference/cli", activeMatch: "/reference/" },
    ],

    sidebar: {
      "/deep-dive/": [
        {
          text: "Deep Dive",
          items: [
            { text: "Source walkthrough: booking, end to end", link: "/deep-dive/source-walkthrough" },
            { text: "Source walkthrough: frontend-golden", link: "/deep-dive/frontend-walkthrough" },
            { text: "Media-platform v6 design audit", link: "/deep-dive/media-platform-v6-audit" },
          ],
        },
      ],
      "/guide/": [
        {
          text: "Introduction",
          items: [
            { text: "What is spec?", link: "/guide/introduction" },
            { text: "Quickstart", link: "/guide/quickstart" },
          ],
        },
        {
          text: "Writing Specifications",
          items: [
            { text: "The .spec.ts language", link: "/guide/language" },
            { text: "Entities & fields", link: "/guide/entities" },
            { text: "REST resources", link: "/guide/rest-resources" },
            { text: "Authentication", link: "/guide/authentication" },
            { text: "Databases", link: "/guide/database" },
            { text: "Backend infrastructure", link: "/guide/infrastructure" },
            { text: "Frontend UIs", link: "/guide/frontend" },
            { text: "The application root", link: "/guide/app-root" },
          ],
        },
        {
          text: "Toolchain",
          items: [
            { text: "CLI", link: "/guide/cli" },
            { text: "Diagnostics", link: "/guide/diagnostics" },
            { text: "Spec IR & determinism", link: "/guide/ir" },
          ],
        },
        {
          text: "Generation",
          items: [
            { text: "Agentic generation", link: "/guide/generate" },
            { text: "The golden rule", link: "/guide/golden-rule" },
            { text: "Why static evaluation", link: "/guide/why-static-evaluation" },
          ],
        },
        {
          text: "Extending",
          items: [
            { text: "Authoring spec packages", link: "/guide/package-authoring" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "CLI reference", link: "/reference/cli" },
            { text: "Diagnostic codes", link: "/reference/diagnostics" },
            { text: "Spec IR format", link: "/reference/ir" },
            { text: "Blueprint format", link: "/reference/blueprint" },
            { text: "Generation internals", link: "/reference/generation" },
            { text: "Git & GitHub execution", link: "/reference/github-execution" },
            { text: "Architecture", link: "/reference/architecture" },
          ],
        },
      ],
    },

    outline: { level: [2, 3] },

    footer: {
      message: "Released under the MIT License.",
      copyright: "spec — Specification Programming MVP",
    },

    search: {
      provider: "local",
    },
  },
})
