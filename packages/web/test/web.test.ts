import { describe, expect, it } from "vitest"
import {
  count,
  crud,
  defaultCrudPath,
  entity,
  expr,
  field,
  invariant,
  isFieldSpec,
  lifecycle,
  transition,
  webPackage,
} from "../src"

describe("@spec/web entity/field", () => {
  it("field builders produce chainable immutable specs", () => {
    const email = field.email()
    expect(isFieldSpec(email)).toBe(true)
    expect(email.type).toBe("email")
    const chained = email.unique().optional()
    expect(chained).not.toBe(email)
    expect(email.uniqueFlag).toBe(false)
    expect(chained.uniqueFlag).toBe(true)
    expect(chained.optionalFlag).toBe(true)
    expect(chained.type).toBe("email")
  })

  it("all six field types exist", () => {
    for (const t of ["string", "int", "boolean", "uuid", "email", "datetime"] as const) {
      expect(field[t]().type).toBe(t)
    }
  })

  it("entity produces an entity node with plain field attributes", () => {
    const User = entity("User", {
      id: field.uuid(),
      email: field.email().unique(),
      name: field.string(),
    })
    expect(User.kind).toBe("entity")
    expect(User.package).toBe("@spec/web")
    expect(User.name).toBe("User")
    expect(User.attributes.fields).toEqual({
      id: { type: "uuid" },
      email: { type: "email", unique: true },
      name: { type: "string" },
    })
  })

  it("entity.fields exposes typed field references", () => {
    const User = entity("User", { email: field.email().unique() })
    expect(User.fields.email).toMatchObject({
      entity: "User",
      field: "email",
      ownerNodeId: "entity:User",
      unique: true,
    })
  })

  it("invalid field definitions pass through for the validator", () => {
    const Bad = entity("Bad", { x: "not-a-field" as never })
    expect(Bad.attributes.fields).toEqual({ x: "not-a-field" })
  })

  it("the package registers validators and an entity inspector", () => {
    expect(webPackage.name).toBe("@spec/web")
    expect(webPackage.validators?.length).toBeGreaterThan(0)
    expect(webPackage.inspectors?.entity).toBeTypeOf("function")
  })
})

describe("@spec/web ref fields", () => {
  it("field.ref produces a ref field with its target", () => {
    const ref = field.ref("User")
    expect(ref.type).toBe("ref")
    expect(ref.refTarget).toBe("User")
    const chained = ref.optional()
    expect(chained.refTarget).toBe("User")
    expect(chained.optionalFlag).toBe(true)
  })

  it("entity flattens ref targets into field attributes", () => {
    const Post = entity("Post", {
      id: field.uuid(),
      author: field.ref("User"),
    })
    expect(Post.attributes.fields).toEqual({
      id: { type: "uuid" },
      author: { type: "ref", target: "User" },
    })
  })
})

describe("@spec/web crud", () => {
  it("crud targets an entity with the default REST path", () => {
    const User = entity("User", { id: field.uuid() })
    const Users = crud(User)
    expect(Users.kind).toBe("crud")
    expect(Users.package).toBe("@spec/web")
    expect(Users.name).toBe("User")
    expect(Users.attributes).toEqual({
      entity: { nodeId: "entity:User" },
      path: "/users",
      auth: true,
    })
  })

  it("crud pluralizes and kebab-cases default paths", () => {
    expect(defaultCrudPath("User")).toBe("/users")
    expect(defaultCrudPath("BlogPost")).toBe("/blog-posts")
    expect(defaultCrudPath("Category")).toBe("/categories")
    expect(defaultCrudPath("Box")).toBe("/boxes")
  })

  it("crud accepts path, methods and auth overrides", () => {
    const Post = entity("Post", { id: field.uuid() })
    const Posts = crud(Post, { path: "/articles", methods: ["list", "get"], auth: false })
    expect(Posts.attributes).toEqual({
      entity: { nodeId: "entity:Post" },
      path: "/articles",
      methods: ["list", "get"],
      auth: false,
    })
  })

  it("invalid targets pass through for the validator", () => {
    const Bad = crud("nope")
    expect(Bad.attributes.entity).toBe("nope")
    expect(Bad.name).toBeUndefined()
  })

  it("the package registers the crud node kind and inspector", () => {
    expect(webPackage.nodeKinds?.map((k) => k.kind)).toContain("crud")
    expect(webPackage.inspectors?.crud).toBeTypeOf("function")
  })
})

describe("@spec/web count", () => {
  it("count() produces an api node with pinned count semantics", () => {
    const Product = entity("Product", { id: field.uuid(), sku: field.string().unique() })
    const ProductCount = count(Product)
    expect(ProductCount.kind).toBe("api")
    expect(ProductCount.name).toBe("ProductCount")
    expect(ProductCount.attributes).toEqual({
      method: "GET",
      operation: "count",
      entity: { nodeId: "entity:Product" },
      path: "/products/count",
      auth: true,
    })
  })

  it("count() accepts path and auth overrides", () => {
    const Product = entity("Product", { id: field.uuid() })
    const c = count(Product, { path: "/catalog/size", auth: false })
    expect(c.attributes.path).toBe("/catalog/size")
    expect(c.attributes.auth).toBe(false)
  })
})

describe("@spec/web lifecycle", () => {
  it("field.enum produces an enum field with its states", () => {
    const status = field.enum("pending", "confirmed", "cancelled")
    expect(status.type).toBe("enum")
    expect(status.states).toEqual(["pending", "confirmed", "cancelled"])
    const chained = status.optional()
    expect(chained.states).toEqual(["pending", "confirmed", "cancelled"])
  })

  it("entity flattens enum states into field attributes", () => {
    const Booking = entity("Booking", { status: field.enum("a", "b") })
    expect(Booking.attributes.fields).toEqual({
      status: { type: "enum", states: ["a", "b"] },
    })
  })

  it("lifecycle() references the entity and serializes transitions as data", () => {
    const Booking = entity("Booking", { status: field.enum("pending", "confirmed") })
    const Flow = lifecycle(Booking, {
      field: "status",
      initial: "pending",
      transitions: [transition("confirm", { from: ["pending"], to: "confirmed" })],
    })
    expect(Flow.kind).toBe("lifecycle")
    expect(Flow.name).toBe("BookingLifecycle")
    expect(Flow.attributes).toEqual({
      entity: { nodeId: "entity:Booking" },
      field: "status",
      initial: "pending",
      transitions: [{ event: "confirm", from: ["pending"], to: "confirmed" }],
    })
  })

  it("the package registers the lifecycle node kind and validator", () => {
    expect(webPackage.nodeKinds?.map((k) => k.kind)).toContain("lifecycle")
  })
})

describe("@spec/web invariant", () => {
  it("expr builders produce chainable pure-data trees", () => {
    const cmp = expr.field("age").gte(expr.const(18))
    expect(cmp.__expr).toBe("cmp")
    expect(cmp.op).toBe("gte")
    expect(cmp.left).toMatchObject({ __expr: "field", name: "age" })
    expect(cmp.right).toEqual({ __expr: "const", value: 18 })
    // comparisons embed the RAW node: no authoring methods leak into data
    expect((cmp.left as { gte?: unknown }).gte).toBeUndefined()
  })

  it("invariant() stores the entity ref and the stripped check tree", () => {
    const Venue = entity("Venue", { id: field.uuid(), capacity: field.int() })
    const Booking = entity("Booking", { id: field.uuid(), venue: field.ref("Venue") })
    const NoOverbooking = invariant("no-overbooking", {
      on: Venue,
      check: expr.countOf(Booking, { venue: "self" }).lte(expr.field("capacity")),
    })
    expect(NoOverbooking.kind).toBe("invariant")
    expect(NoOverbooking.name).toBe("no-overbooking")
    expect(NoOverbooking.attributes.on).toEqual({ nodeId: "entity:Venue" })
    // chain methods are stripped; only data remains
    expect(NoOverbooking.attributes.check).toEqual({
      __expr: "cmp",
      op: "lte",
      left: { __expr: "countOf", entity: "Booking", filter: { venue: "self" } },
      right: { __expr: "field", name: "capacity" },
    })
  })

  it("row-local checks serialize as data too", () => {
    const Post = entity("Post", { id: field.uuid(), title: field.string() })
    const inv = invariant("no-empty-title", {
      on: Post,
      check: expr.field("title").neq(expr.const("")),
    })
    expect(inv.attributes.check).toEqual({
      __expr: "cmp",
      op: "neq",
      left: { __expr: "field", name: "title" },
      right: { __expr: "const", value: "" },
    })
  })

  it("the package registers the invariant node kind and validator", () => {
    expect(webPackage.nodeKinds?.map((k) => k.kind)).toContain("invariant")
  })
})
