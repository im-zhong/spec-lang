import { stableStringify } from "@spec/core"
import type { FrontendBlueprint } from "./blueprint"

const RUNTIME_SOURCE = String.raw`import React, { useMemo, useState } from "react"

type AnyRecord = Record<string, any>

function componentChildren(node: AnyRecord): AnyRecord[] {
  const props = node && node.props ? node.props : {}
  if (Array.isArray(props.children)) return props.children
  if (Array.isArray(props.items)) return props.items
  if (Array.isArray(props.fields)) return props.fields
  return []
}

function initialTabs(node: any, out: Record<string, string> = {}): Record<string, string> {
  if (!node || typeof node !== "object") return out
  if (node.__uiComponent === true && node.kind === "tabs" && node.props && typeof node.props.id === "string") {
    out[node.props.id] = String(node.props.defaultValue)
  }
  if (Array.isArray(node)) node.forEach((item) => initialTabs(item, out))
  else Object.values(node).forEach((item) => initialTabs(item, out))
  return out
}

function stateCollections(items: any[]): Record<string, AnyRecord[]> {
  const result: Record<string, AnyRecord[]> = {}
  for (const item of items || []) {
    if (item && item.__uiState === true && item.kind === "collection") {
      result[item.name] = Array.isArray(item.initial) ? item.initial : []
    }
  }
  return result
}

function display(value: unknown): string {
  if (value === null || value === undefined) return ""
  return String(value)
}

export function SpecApp({ blueprint }: { blueprint: AnyRecord }) {
  const screen = useMemo(() => {
    const path = window.location.pathname
    return blueprint.screens.find((item: AnyRecord) => item.path === path) || blueprint.screens[0]
  }, [blueprint])
  const [collections, setCollections] = useState<Record<string, AnyRecord[]>>(() => stateCollections(screen.state))
  const [tabs, setTabs] = useState<Record<string, string>>(() => initialTabs(screen.body))
  const [alerts, setAlerts] = useState<Record<string, string>>({})

  const resolveValue = (value: any): unknown => {
    if (value && value.__uiBinding === true) {
      if (value.kind === "stateCount") return (collections[value.source] || []).length
      if (value.kind === "stateValue") return value.source
    }
    return value
  }

  const runAction = (action: AnyRecord, form?: HTMLFormElement): void => {
    if (!action || action.__uiAction !== true) return
    if (action.kind === "sequence") {
      for (const item of action.actions || []) runAction(item, form)
      return
    }
    if (action.kind === "append") {
      const data = form ? new FormData(form) : new FormData()
      setCollections((previous) => {
        const current = previous[action.collection] || []
        const row: AnyRecord = { id: "item-" + String(current.length + 1) }
        for (const [outputField, inputId] of Object.entries(action.fields || {})) {
          row[outputField] = display(data.get(String(inputId)))
        }
        return { ...previous, [action.collection]: [...current, row] }
      })
      return
    }
    if (action.kind === "notify") {
      setAlerts((previous) => ({ ...previous, [action.target]: String(action.message) }))
      return
    }
    if (action.kind === "selectTab") {
      setTabs((previous) => ({ ...previous, [action.target]: String(action.value) }))
      return
    }
    if (action.kind === "resetForm") {
      form?.reset()
      return
    }
    if (action.kind === "navigate") window.location.assign(String(action.path))
  }

  const render = (node: AnyRecord, key: string): React.ReactNode => {
    if (!node || node.__uiComponent !== true) return null
    const props = node.props || {}
    const data = { "data-component": node.kind, "data-spec-key": key }
    switch (node.kind) {
      case "appShell":
        return <div className="spec-shell" {...data} key={key}>
          <aside className="spec-sidebar" data-component="sidebar">
            <div className="spec-brand"><span className="spec-brand-mark">S</span><span>{props.brand}</span></div>
            <nav aria-label="Primary navigation">
              {(props.navigation || []).map((item: AnyRecord, index: number) =>
                <a className={window.location.pathname === item.href ? "spec-nav-item active" : "spec-nav-item"} href={item.href} key={item.href || index}>
                  <span className="spec-nav-icon" aria-hidden="true">{display(item.icon || item.label).slice(0, 1)}</span>
                  <span>{item.label}</span>
                </a>)}
            </nav>
            <div className="spec-sidebar-footer">Generated from one specification</div>
          </aside>
          <main className="spec-main" data-component="main"><div className="spec-content">{render(props.content, key + ".content")}</div></main>
        </div>
      case "stack":
        return <div className={"spec-stack gap-" + String(props.gap || "md")} {...data} key={key}>
          {componentChildren(node).map((child, index) => render(child, key + "." + index))}
        </div>
      case "grid":
        return <div className={"spec-grid columns-" + String(props.columns || 2) + " gap-" + String(props.gap || "md")} {...data} key={key}>
          {componentChildren(node).map((child, index) => render(child, key + "." + index))}
        </div>
      case "card":
        return <section className="spec-card" {...data} key={key}>
          {props.title ? <h3 className="spec-card-title">{props.title}</h3> : null}
          {componentChildren(node).map((child, index) => render(child, key + "." + index))}
        </section>
      case "heading": {
        const Heading = props.level === 1 ? "h1" : props.level === 2 ? "h2" : "h3"
        return <header className="spec-heading" {...data} key={key}>
          <Heading>{props.text}</Heading>{props.subtitle ? <p>{props.subtitle}</p> : null}
        </header>
      }
      case "text":
        return <p className={"spec-text tone-" + String(props.tone || "default")} {...data} key={key}>{props.text}</p>
      case "stat":
        return <section className="spec-stat" {...data} key={key}>
          <span className="spec-stat-label">{props.label}</span>
          <strong className="spec-stat-value">{display(resolveValue(props.value))}</strong>
          {props.detail ? <span className="spec-stat-detail">{props.detail}</span> : null}
        </section>
      case "tabs": {
        const active = tabs[props.id] || props.defaultValue
        return <section className="spec-tabs" id={props.id} {...data} key={key}>
          <div className="spec-tab-list" role="tablist" aria-label={screen.title + " sections"}>
            {(props.items || []).map((item: AnyRecord) => <button
              type="button" role="tab" id={props.id + "-tab-" + item.props.value}
              aria-selected={active === item.props.value}
              aria-controls={props.id + "-panel-" + item.props.value}
              tabIndex={active === item.props.value ? 0 : -1}
              className={active === item.props.value ? "spec-tab active" : "spec-tab"}
              onClick={() => setTabs((previous) => ({ ...previous, [props.id]: item.props.value }))}
              key={item.props.value}>{item.props.label}</button>)}
          </div>
          {(props.items || []).map((item: AnyRecord, index: number) => active === item.props.value
            ? <div role="tabpanel" id={props.id + "-panel-" + item.props.value} aria-labelledby={props.id + "-tab-" + item.props.value} className="spec-tab-panel" key={item.props.value}>
                {render(item.props.content, key + ".tab." + index)}
              </div>
            : null)}
        </section>
      }
      case "tab": return render(props.content, key + ".content")
      case "form":
        return <form className="spec-form" id={props.id} {...data} key={key} onSubmit={(event) => {
          event.preventDefault()
          runAction(props.submit.action, event.currentTarget)
        }}>
          <div className="spec-form-fields">{(props.fields || []).map((field: AnyRecord, index: number) => render(field, key + ".field." + index))}</div>
          <div className="spec-form-actions"><button className="spec-button primary" type="submit">{props.submit.label}</button></div>
        </form>
      case "input":
        return <label className="spec-field" key={key} {...data}>
          <span>{props.label}{props.required ? <b aria-hidden="true"> *</b> : null}</span>
          <input id={props.id} name={props.id} type={props.type || "text"} placeholder={props.placeholder || ""} required={props.required === true} />
        </label>
      case "select":
        return <label className="spec-field" key={key} {...data}>
          <span>{props.label}{props.required ? <b aria-hidden="true"> *</b> : null}</span>
          <select id={props.id} name={props.id} required={props.required === true} defaultValue="">
            <option value="" disabled>Select {String(props.label).toLowerCase()}</option>
            {(props.options || []).map((option: AnyRecord) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </label>
      case "table": {
        const rows = collections[props.source] || []
        return <section className="spec-table-wrap" {...data} key={key}>
          {rows.length === 0 ? <div className="spec-empty"><h3>{props.empty.title}</h3><p>{props.empty.description}</p></div>
            : <table><thead><tr>{(props.columns || []).map((column: AnyRecord) => <th scope="col" key={column.field}>{column.label}</th>)}</tr></thead>
                <tbody>{rows.map((row: AnyRecord, rowIndex: number) => <tr key={row.id || rowIndex}>{(props.columns || []).map((column: AnyRecord) => <td key={column.field}>
                  {column.presentation === "badge" ? <span className={"spec-badge value-" + display(row[column.field]).toLowerCase()}>{display(row[column.field])}</span> : display(row[column.field])}
                </td>)}</tr>)}</tbody></table>}
        </section>
      }
      case "alert": {
        const message = alerts[props.id]
        return message ? <div role="status" className={"spec-alert tone-" + String(props.tone || "info")} {...data} key={key}>{message}</div> : null
      }
      default: return null
    }
  }

  return <div data-theme-accent={blueprint.theme.accent} data-screen={screen.name}>
    {render(screen.body, "screen")}
  </div>
}
`

const RUNTIME_CSS = String.raw`:root {
  font-family: Arial, Helvetica, sans-serif;
  color: #172033;
  background: #f4f6fb;
  font-synthesis: none;
}
* { box-sizing: border-box; }
html, body, #root { min-width: 320px; min-height: 100%; margin: 0; }
body { min-height: 100vh; background: #f4f6fb; }
button, input, select { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
.spec-shell { display: grid; grid-template-columns: 264px minmax(0, 1fr); min-height: 100vh; }
.spec-sidebar { position: fixed; inset: 0 auto 0 0; width: 264px; padding: 30px 22px; display: flex; flex-direction: column; color: #eef2ff; background: #172554; }
.spec-brand { display: flex; align-items: center; gap: 12px; padding: 0 10px 30px; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
.spec-brand-mark { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 10px; color: #172554; background: #c7d2fe; }
.spec-sidebar nav { display: grid; gap: 7px; }
.spec-nav-item { display: flex; align-items: center; gap: 12px; min-height: 46px; padding: 0 12px; border-radius: 10px; color: #c7d2fe; text-decoration: none; font-size: 14px; font-weight: 600; }
.spec-nav-item.active { color: white; background: #3346a8; box-shadow: inset 3px 0 0 #a5b4fc; }
.spec-nav-icon { width: 27px; height: 27px; display: grid; place-items: center; border-radius: 8px; background: rgba(255,255,255,.09); font-size: 12px; }
.spec-sidebar-footer { margin-top: auto; padding: 18px 10px 0; border-top: 1px solid rgba(255,255,255,.14); color: #a5b4fc; font-size: 11px; line-height: 1.5; }
.spec-main { grid-column: 2; min-width: 0; min-height: 100vh; padding: 48px; }
.spec-content { width: 100%; max-width: 1120px; margin: 0 auto; }
.spec-stack { display: flex; flex-direction: column; }
.gap-xs { gap: 8px; } .gap-sm { gap: 12px; } .gap-md { gap: 20px; } .gap-lg { gap: 28px; } .gap-xl { gap: 40px; }
.spec-grid { display: grid; } .columns-1 { grid-template-columns: 1fr; } .columns-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); } .columns-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); } .columns-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.spec-heading h1, .spec-heading h2, .spec-heading h3 { margin: 0; color: #172033; letter-spacing: -.035em; }
.spec-heading h1 { font-size: 34px; line-height: 1.15; } .spec-heading h2 { font-size: 25px; } .spec-heading h3 { font-size: 19px; }
.spec-heading p { margin: 9px 0 0; color: #667085; font-size: 15px; line-height: 1.55; }
.spec-card, .spec-stat, .spec-tabs { border: 1px solid #e3e7ef; border-radius: 16px; background: #ffffff; box-shadow: 0 8px 24px rgba(23, 32, 51, .045); }
.spec-card { padding: 24px; } .spec-card-title { margin: 0 0 18px; font-size: 16px; }
.spec-stat { min-height: 135px; padding: 23px 24px; display: flex; flex-direction: column; }
.spec-stat-label { color: #667085; font-size: 13px; font-weight: 600; }
.spec-stat-value { margin-top: 12px; color: #172033; font-size: 31px; line-height: 1; letter-spacing: -.04em; }
.spec-stat-detail { margin-top: auto; padding-top: 13px; color: #64748b; font-size: 12px; }
.spec-tabs { overflow: hidden; }
.spec-tab-list { height: 62px; display: flex; align-items: end; gap: 5px; padding: 0 24px; border-bottom: 1px solid #e3e7ef; }
.spec-tab { height: 45px; padding: 0 16px; border: 0; border-bottom: 3px solid transparent; color: #667085; background: transparent; cursor: pointer; font-size: 14px; font-weight: 700; }
.spec-tab.active { color: #3346a8; border-bottom-color: #4f63d8; }
.spec-tab:focus-visible, .spec-button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 3px solid #a5b4fc; outline-offset: 2px; }
.spec-tab-panel { min-height: 310px; padding: 26px 28px 30px; }
.spec-form { display: grid; gap: 24px; }
.spec-form-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.spec-field { display: grid; gap: 8px; color: #344054; font-size: 13px; font-weight: 700; }
.spec-field:first-child { grid-column: 1 / -1; }
.spec-field b { color: #dc2626; }
.spec-field input, .spec-field select { width: 100%; height: 46px; padding: 0 13px; border: 1px solid #cfd6e3; border-radius: 10px; color: #172033; background: white; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
.spec-field input::placeholder { color: #98a2b3; }
.spec-field input:focus, .spec-field select:focus { border-color: #667eea; }
.spec-form-actions { display: flex; justify-content: flex-end; padding-top: 3px; }
.spec-button { min-height: 44px; padding: 0 19px; border: 0; border-radius: 10px; cursor: pointer; font-weight: 700; }
.spec-button.primary { color: white; background: #4f63d8; box-shadow: 0 5px 12px rgba(79,99,216,.24); }
.spec-table-wrap { overflow: hidden; border: 1px solid #e3e7ef; border-radius: 12px; }
.spec-table-wrap table { width: 100%; border-collapse: collapse; }
.spec-table-wrap th { height: 45px; padding: 0 18px; color: #667085; background: #f8fafc; text-align: left; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
.spec-table-wrap td { height: 54px; padding: 0 18px; border-top: 1px solid #edf0f5; color: #344054; font-size: 14px; }
.spec-table-wrap tbody tr:hover { background: #fafbff; }
.spec-badge { display: inline-flex; align-items: center; min-height: 25px; padding: 0 9px; border-radius: 999px; color: #344054; background: #eef2f6; font-size: 11px; font-weight: 800; text-transform: capitalize; }
.spec-badge.value-high { color: #9f1239; background: #ffe4e6; } .spec-badge.value-medium { color: #92400e; background: #fef3c7; } .spec-badge.value-low { color: #166534; background: #dcfce7; }
.spec-alert { padding: 12px 14px; border-radius: 10px; font-size: 13px; font-weight: 700; }
.spec-alert.tone-success { color: #166534; background: #dcfce7; }
.spec-empty { padding: 50px 24px; text-align: center; } .spec-empty h3 { margin: 0 0 6px; } .spec-empty p { margin: 0; color: #667085; }
.spec-text { margin: 0; line-height: 1.55; } .spec-text.tone-muted { color: #667085; }
@media (max-width: 900px) {
  .spec-shell { display: block; } .spec-sidebar { position: static; width: 100%; min-height: auto; padding: 18px; }
  .spec-sidebar nav { display: flex; overflow-x: auto; } .spec-sidebar-footer { display: none; }
  .spec-main { padding: 28px 20px; } .columns-3, .columns-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .columns-2, .columns-3, .columns-4, .spec-form-fields { grid-template-columns: 1fr; }
  .spec-field:first-child { grid-column: auto; } .spec-tab-panel { padding: 22px 18px; }
}
@media (prefers-reduced-motion: no-preference) { .spec-tab, .spec-nav-item, .spec-button { transition: color .15s, background-color .15s, border-color .15s, transform .15s; } }
`

export function buildRuntimeFiles(blueprint: FrontendBlueprint): Record<string, string> {
  return {
    ".gitignore": "node_modules/\ndist/\nconformance-output/test-results/\n",
    "src/frontend.blueprint.json": stableStringify(blueprint) + "\n",
    "src/spec-runtime.tsx": RUNTIME_SOURCE,
    "src/spec-runtime.css": RUNTIME_CSS,
  }
}
