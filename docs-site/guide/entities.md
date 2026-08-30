# Entities & fields

The `@spec/web` package provides the data-model vocabulary: `entity`,
`field`, `page` and `api`. Entities and fields are the core of it.

## Declaring an entity

```ts
import { entity, field } from "@spec/web"

const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
  name: field.string(),
})
```

An entity is a named collection of fields. The compiler turns it into an
IR node:

```json
{
  "id": "entity:User",
  "kind": "entity",
  "package": "@spec/web",
  "name": "User",
  "attributes": {
    "fields": {
      "id": { "type": "uuid" },
      "email": { "type": "email", "unique": true },
      "name": { "type": "string" }
    }
  }
}
```

## Field types

| Builder              | Type        |
| -------------------- | ----------- |
| `field.string()`     | `string`    |
| `field.int()`        | `int`       |
| `field.boolean()`    | `boolean`   |
| `field.uuid()`       | `uuid`      |
| `field.email()`      | `email`     |
| `field.datetime()`   | `datetime`  |

## Modifiers

Field builders are immutable and chainable:

```ts
field.email()          // { type: "email" }
  .unique()            // + unique: true
  .optional()          // + optional: true
  .default("a@b.c")    // + default value
```

Each call returns a **new** field spec — the original is never mutated,
which keeps specifications declarative and diff-friendly.

| Modifier             | Meaning                                          |
| -------------------- | ------------------------------------------------ |
| `.unique()`          | Values are unique across rows                    |
| `.optional()`        | The field may be absent                          |
| `.default(value)`    | Value used when none is supplied                 |

## Typed field references

Entities expose their fields so other packages can reference them with
full type inference:

```ts
User.fields.id      // { entity: "User", field: "id" }
User.fields.email   // { entity: "User", field: "email" }
```

This is how authentication binds an identity to a concrete field (see
[Authentication](/guide/authentication)). In the IR, a field reference
serializes as data:

```json
{
  "__fieldRef": true,
  "entity": "User",
  "field": "email",
  "owner": "entity:User"
}
```

## Validation rules

The `@spec/web` package registers semantic validators, so these mistakes
are caught at compile time:

**Duplicate entity names**

```ts
const User = entity("User", { id: field.uuid() })
const Alias = entity("User", { id: field.uuid() }) // ✗
```

```
DUPLICATE_ENTITY_NAME — Duplicate entity name "User" ...
```

**Duplicate field names** — object literals with repeated keys produce
`SPEC_DUPLICATE_KEY` (syntax layer) and `DUPLICATE_FIELD_NAME` (web layer).

**Invalid field definitions**

```ts
const Bad = entity("Bad", { x: "just a string" }) // ✗ not a field builder
```

```
INVALID_FIELD_DEFINITION — Field "Bad.x" is not a valid field definition
(use e.g. field.string()).
```

**Unknown field types** produce `FIELD_TYPE_UNKNOWN` and list the
supported types.

## Pages and APIs (vocabulary preview)

`page` and `api` exist as stable vocabulary placeholders for the next
phase:

```ts
import { page, api } from "@spec/web"

const Home = page({ path: "/", title: "Home" })
const ListUsers = api({ path: "/users", method: "GET" })
```

They compile into `page` / `api` IR nodes; generation comes later.
