import { defineApp, spec } from "@spec/core"
import { entity, field, crud } from "@spec/web"
import { postgres } from "@spec/postgres"
import { fastapi } from "@spec/fastapi"

// StorePlatform — three FastAPI services, ~1000 generated lines. Every
// boundary is an interface between two backend modules: interfaces are not
// a frontend/backend concept, they bind ANY two modules.

const WarehouseApi = spec.interface("WarehouseApi", {
  protocol: "http-json",
  version: "1",
  operations: {
    listItems: {
      output: [{ id: "uuid", sku: "string", name: "string", quantityOnHand: "int", active: "boolean" }],
      transport: { method: "GET", path: "/api/items" },
    },
  },
})

const OrderApi = spec.interface("OrderApi", {
  protocol: "http-json",
  version: "1",
  operations: {
    listOrders: {
      output: [{ id: "uuid", reference: "string", quantity: "int", status: "string" }],
      transport: { method: "GET", path: "/api/orders" },
    },
  },
})

const Item = entity("Item", {
  id: field.uuid(),
  sku: field.string().unique(),
  name: field.string(),
  quantityOnHand: field.int().default(0),
  active: field.boolean().default(true),
})
const Items = crud(Item)
const WarehouseDb = postgres({ entities: [Item] })
const WarehouseServer = fastapi({ title: "Warehouse API", prefix: "/api", services: [Items], resources: [WarehouseDb] })

const Order = entity("Order", {
  id: field.uuid(),
  reference: field.string().unique(),
  quantity: field.int().default(1),
  status: field.enum("placed", "fulfilled", "cancelled").default("placed"),
})
const Orders = crud(Order, { methods: ["list", "get", "create"] })
const OrdersDb = postgres({ entities: [Order] })
const OrdersServer = fastapi({ title: "Orders API", prefix: "/api", services: [Orders], resources: [OrdersDb] })

const Report = entity("Report", {
  id: field.uuid(),
  title: field.string(),
  metric: field.enum("orders", "stock"),
  total: field.int().default(0),
  ready: field.boolean().default(false),
})
const Reports = crud(Report, { methods: ["list", "get", "create"] })
const ReportingDb = postgres({ entities: [Report] })
const ReportingServer = fastapi({ title: "Reporting API", prefix: "/api", services: [Reports], resources: [ReportingDb] })

const Warehouse = spec.module("warehouse", {
  target: "fastapi",
  provides: [WarehouseApi],
  contains: [Item, Items, WarehouseDb, WarehouseServer],
})
const OrderService = spec.module("orders", {
  target: "fastapi",
  provides: [OrderApi],
  calls: [spec.call(WarehouseApi, "listItems")],
  contains: [Order, Orders, OrdersDb, OrdersServer],
})
const Reporting = spec.module("reporting", {
  target: "fastapi",
  calls: [spec.call(OrderApi, "listOrders"), spec.call(WarehouseApi, "listItems")],
  contains: [Report, Reports, ReportingDb, ReportingServer],
})

export default defineApp({
  name: "StorePlatform",
  entities: [Item, Order, Report],
  services: [Items, Orders, Reports],
  resources: [WarehouseDb, WarehouseServer, OrdersDb, OrdersServer, ReportingDb, ReportingServer],
  modules: [Warehouse, OrderService, Reporting],
})
