# Frontend UIs

Frontends are specified with `@spec/ui` and rendered through a
compiler-owned React runtime. You describe screens, components, state, and
actions as plain data; the agent only writes the three-file integration
shell around a runtime it must never modify.

```ts
import { action, bind, frontend, screen, state, ui } from "@spec/ui"
import { react } from "@spec/react"
```

## Screens and the frontend root

A screen is one route: a path, a title, optional screen-local state, and a
component tree. The `frontend` node owns the document title, theme, and the
screen list; the `react` target selects the rendering stack and port.

```ts
const Workspace = screen("Workspace", {
  path: "/",
  title: "Workspace dashboard",
  state: [state.collection("projects", [/* initial rows */])],
  body: ui.appShell({ brand: "Spec Studio", navigation, content: ui.stack({ children: [/* … */] }) }),
})

const Client = frontend({
  title: "Spec Studio",
  theme: { accent: "indigo", density: "comfortable", radius: "large" },
  screens: [Workspace, Projects, Reports],
})

const Browser = react({ frontend: Client, port: 4173 })
```

Routing is by pathname. Every screen must declare a unique path starting
with `/`, and every screen's body must be an `appShell` — the compiler-owned
layout that renders the brand sidebar, primary navigation, and content well.

## Component vocabulary

Fourteen component kinds, closed and statically validated:

| Kind | Purpose |
| --- | --- |
| `appShell` | brand sidebar + navigation + content root (required screen body) |
| `stack`, `grid` | vertical and column layout with named gaps (xs–xl) and 1–4 columns |
| `card`, `heading`, `text`, `stat` | content presentation; stats bind to live state |
| `tabs`, `tab` | single-active ARIA tablist with declared default |
| `form`, `input`, `select` | native-validation forms with declarative submit actions |
| `table` | collection-backed table with badge presentation and empty state |
| `alert` | role="status" region targeted by `notify` |

State is screen-local: `state.collection(name, initial)` for tables and
appends, `state.value(name, initial)` for single values. Bindings read it at
render time — `bind.count("projects")` makes a stat live.

## Actions

Submit actions are declared, ordered, and statically checked against the
screen's own ids:

```ts
submit: {
  label: "Create project",
  action: action.sequence([
    action.append("projects", { fromForm: "project-form", fields: { name: "project-name", owner: "project-owner", priority: "project-priority" } }),
    action.notify("project-success", "Project added successfully."),
    action.selectTab("workspace-tabs", "overview"),
    action.resetForm("project-form"),
  ]),
}
```

`append` derives row ids deterministically (`collection length + 1`).
Unknown collections, forms, tab targets, or alert targets are compile-time
errors.

## Navigation must be real

Navigation is declared per app shell and must point at declared screens:

```ts
const navigation = [
  { label: "Workspace", href: "/", icon: "W" },
  { label: "Projects", href: "/projects", icon: "P" },
  { label: "Reports", href: "/reports", icon: "R" },
]
```

An href that matches no screen path is a `UI_NAV_TARGET_UNKNOWN` compile
error. This is the correctness clause of the golden rule applied to
frontends: two shots can render the same dead link identically — the spec
language refuses dead navigation before any generation spends money.

## What generation produces

`spec generate-frontend examples/frontend-golden/app.spec.ts --shots 2`
compiles the blueprint, writes an immutable runtime (`spec-runtime.tsx`,
`spec-runtime.css`, the blueprint JSON) into each shot workspace, and has
the agent write exactly three files: `package.json`, `index.html`,
`src/main.tsx`. The Playwright oracle then verifies, per shot, on the first
attempt: every declared screen's layout and colors, click-through navigation
to each declared screen, and the scripted form interaction — captured as
pixel hashes and a behavior snapshot that must be identical across shots.
