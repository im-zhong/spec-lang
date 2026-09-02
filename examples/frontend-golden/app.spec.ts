import { defineApp } from "@spec/core"
import { action, bind, frontend, screen, state, ui } from "@spec/ui"
import { react } from "@spec/react"

const navigation = [
  { label: "Workspace", href: "/", icon: "W" },
  { label: "Projects", href: "/projects", icon: "P" },
  { label: "Reports", href: "/reports", icon: "R" },
]

const Workspace = screen("Workspace", {
  path: "/",
  title: "Workspace dashboard",
  state: [
    state.collection("projects", [
      { id: "project-1", name: "Northstar launch", owner: "Maya Chen", priority: "High" },
      { id: "project-2", name: "Mobile onboarding", owner: "Elias Stone", priority: "Medium" },
      { id: "project-3", name: "Billing refresh", owner: "Nora Singh", priority: "Low" },
    ]),
  ],
  body: ui.appShell({
    brand: "Spec Studio",
    navigation,
    content: ui.stack({
      gap: "lg",
      children: [
        ui.heading("Workspace dashboard", {
          subtitle: "Plan, prioritize, and track the team’s active work.",
        }),
        ui.grid({
          columns: 3,
          gap: "md",
          children: [
            ui.stat({ label: "Active projects", value: bind.count("projects"), detail: "Across the product studio" }),
            ui.stat({ label: "In review", value: 2, detail: "One review due today" }),
            ui.stat({ label: "Completion", value: "78%", detail: "Up 6% from last week" }),
          ],
        }),
        ui.tabs({
          id: "workspace-tabs",
          defaultValue: "overview",
          items: [
            ui.tab({
              value: "overview",
              label: "Overview",
              content: ui.stack({
                gap: "md",
                children: [
                  ui.alert({ id: "project-success", tone: "success" }),
                  ui.table({
                    source: "projects",
                    columns: [
                      { field: "name", label: "Project" },
                      { field: "owner", label: "Owner" },
                      { field: "priority", label: "Priority", presentation: "badge" },
                    ],
                    empty: { title: "No projects", description: "Add the first project to start planning." },
                  }),
                ],
              }),
            }),
            ui.tab({
              value: "create",
              label: "Add project",
              content: ui.card({
                title: "Project details",
                children: [
                  ui.form({
                    id: "project-form",
                    fields: [
                      ui.input({ id: "project-name", label: "Project name", placeholder: "e.g. Atlas launch", required: true }),
                      ui.input({ id: "project-owner", label: "Owner", placeholder: "Team member", required: true }),
                      ui.select({
                        id: "project-priority",
                        label: "Priority",
                        required: true,
                        options: [
                          { value: "High", label: "High" },
                          { value: "Medium", label: "Medium" },
                          { value: "Low", label: "Low" },
                        ],
                      }),
                    ],
                    submit: {
                      label: "Create project",
                      action: action.sequence([
                        action.append("projects", {
                          fromForm: "project-form",
                          fields: {
                            name: "project-name",
                            owner: "project-owner",
                            priority: "project-priority",
                          },
                        }),
                        action.notify("project-success", "Project added successfully."),
                        action.selectTab("workspace-tabs", "overview"),
                        action.resetForm("project-form"),
                      ]),
                    },
                  }),
                ],
              }),
            }),
          ],
        }),
      ],
    }),
  }),
})

const Projects = screen("Projects", {
  path: "/projects",
  title: "Projects",
  state: [
    state.collection("projects", [
      { id: "project-1", name: "Northstar launch", owner: "Maya Chen", priority: "High" },
      { id: "project-2", name: "Mobile onboarding", owner: "Elias Stone", priority: "Medium" },
      { id: "project-3", name: "Billing refresh", owner: "Nora Singh", priority: "Low" },
      { id: "project-4", name: "Atlas rollout", owner: "Priya Nair", priority: "High" },
    ]),
  ],
  body: ui.appShell({
    brand: "Spec Studio",
    navigation,
    content: ui.stack({
      gap: "lg",
      children: [
        ui.heading("Projects", {
          subtitle: "Every active engagement across the studio.",
        }),
        ui.stat({ label: "Active projects", value: bind.count("projects"), detail: "Updated from the workspace board" }),
        ui.table({
          source: "projects",
          columns: [
            { field: "name", label: "Project" },
            { field: "owner", label: "Owner" },
            { field: "priority", label: "Priority", presentation: "badge" },
          ],
          empty: { title: "No projects", description: "Add the first project from the workspace." },
        }),
      ],
    }),
  }),
})

const Reports = screen("Reports", {
  path: "/reports",
  title: "Reports",
  body: ui.appShell({
    brand: "Spec Studio",
    navigation,
    content: ui.stack({
      gap: "lg",
      children: [
        ui.heading("Reports", {
          subtitle: "Delivery health across the studio.",
        }),
        ui.grid({
          columns: 3,
          gap: "md",
          children: [
            ui.stat({ label: "On-time delivery", value: "92%", detail: "Last 30 days" }),
            ui.stat({ label: "Review turnaround", value: "1.4d", detail: "Median across teams" }),
            ui.stat({ label: "Open risks", value: 3, detail: "Two mitigation plans in review" }),
          ],
        }),
        ui.card({
          title: "Summary",
          children: [
            ui.text("The studio is tracking 4 active projects with no blocked work this week."),
            ui.text("Completion is up 6% from last week.", { tone: "muted" }),
          ],
        }),
      ],
    }),
  }),
})

const Client = frontend({
  title: "Spec Studio",
  theme: { accent: "indigo", density: "comfortable", radius: "large" },
  screens: [Workspace, Projects, Reports],
})

const Browser = react({
  frontend: Client,
  port: 4173,
})

export default defineApp({
  name: "SpecStudio",
  resources: [Client, Browser],
})
