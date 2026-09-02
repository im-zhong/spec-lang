import { describe, expect, it } from "vitest"
import { action, bind, frontend, screen, state, ui, uiPackage } from "../src"

describe("@spec/ui component vocabulary", () => {
  it("serializes layout, state, form, tabs, bindings, and actions as plain data", () => {
    const Dashboard = screen("Dashboard", {
      path: "/",
      title: "Dashboard",
      state: [state.collection("items", [{ id: "1", name: "First" }])],
      body: ui.tabs({
        id: "tabs",
        defaultValue: "list",
        items: [
          ui.tab({
            value: "list",
            label: "List",
            content: ui.stack({
              children: [
                ui.stat({ label: "Items", value: bind.count("items") }),
                ui.table({ source: "items", columns: [{ field: "name", label: "Name" }], empty: { title: "Empty" } }),
              ],
            }),
          }),
          ui.tab({
            value: "new",
            label: "New",
            content: ui.form({
              id: "item-form",
              fields: [ui.input({ id: "name", label: "Name", required: true })],
              submit: { label: "Add", action: action.append("items", { fromForm: "item-form", fields: { name: "name" } }) },
            }),
          }),
        ],
      }),
    })
    const Client = frontend({ title: "Client", screens: [Dashboard] })

    expect(Dashboard.kind).toBe("screen")
    expect(Dashboard.attributes.body).toMatchObject({ __uiComponent: true, kind: "tabs" })
    expect(Client.attributes.screens).toEqual([{ nodeId: "screen:Dashboard" }])
    expect(uiPackage.nodeKinds?.map((node) => node.kind)).toEqual(["screen", "frontend"])
  })
})
