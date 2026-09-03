import { defineApp, spec } from "@spec/core"
import { entity, field, crud } from "@spec/web"
import { postgres } from "@spec/postgres"
import { fastapi } from "@spec/fastapi"

/** Public contract owned by Catalog and consumed by Reporting. */
const CatalogApi = spec.interface("CatalogApi", {
  protocol: "http-json",
  version: "1",
  operations: {
    listProducts: {
      output: [{
        id: "uuid",
        sku: "string",
        name: "string",
        price: "int",
        active: "boolean",
      }],
      errors: {
        unavailable: { status: 503, body: { detail: "Unavailable" } },
      },
      transport: { method: "GET", path: "/api/products" },
    },
  },
})

const Product = entity("Product", {
  id: field.uuid(),
  sku: field.string().unique(),
  name: field.string(),
  price: field.int(),
  active: field.boolean().default(true),
})
const Products = crud(Product)
const CatalogDb = postgres({ entities: [Product] })
const CatalogServer = fastapi({
  title: "Catalog API",
  prefix: "/api",
  services: [Products],
  resources: [CatalogDb],
})

const Report = entity("Report", {
  id: field.uuid(),
  name: field.string(),
  format: field.enum("json", "csv"),
  ready: field.boolean().default(false),
})
const Reports = crud(Report, { methods: ["list", "get", "create"] })
const ReportingDb = postgres({ entities: [Report] })
const ReportingServer = fastapi({
  title: "Reporting API",
  prefix: "/api",
  services: [Reports],
  resources: [ReportingDb],
})

const Catalog = spec.module("catalog", {
  target: "fastapi",
  provides: [CatalogApi],
  contains: [Product, Products, CatalogDb, CatalogServer],
})

const Reporting = spec.module("reporting", {
  target: "fastapi",
  calls: [spec.call(CatalogApi, "listProducts")],
  contains: [Report, Reports, ReportingDb, ReportingServer],
})

export default defineApp({
  name: "InterfaceFastApiGolden",
  entities: [Product, Report],
  services: [Products, Reports],
  resources: [CatalogDb, CatalogServer, ReportingDb, ReportingServer],
  modules: [Catalog, Reporting],
})
