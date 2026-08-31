import { defineApp } from "@spec/core"
import { entity, field, crud, count } from "@spec/web"
import { postgres } from "@spec/postgres"
import { fastapi } from "@spec/fastapi"

/**
 * Project 2 — Inventory API.
 * Purpose: unauthenticated internal inventory service.
 * Features: NO auth (all public), unique string fields, int/boolean
 * defaults, optional fields, a count endpoint, versioned prefix.
 */

const Product = entity("Product", {
  id: field.uuid(),
  sku: field.string().unique(),
  name: field.string(),
  price: field.int(),
  description: field.string().optional(),
  inStock: field.boolean().default(true),
  discontinued: field.boolean().default(false),
})

const Category = entity("Category", {
  id: field.uuid(),
  name: field.string().unique(),
  slug: field.string().unique(),
})

const Products = crud(Product)
const Categories = crud(Category)
const ProductCount = count(Product)

const MainDB = postgres({ entities: [Product, Category] })

const Server = fastapi({
  title: "Inventory API",
  prefix: "/api/v1",
  services: [Products, Categories, ProductCount],
  resources: [MainDB],
})

export default defineApp({
  name: "InventoryAPI",
  entities: [Product, Category],
  services: [Products, Categories, ProductCount],
  resources: [MainDB, Server],
})
