# The application root

`defineApp` from `@spec/core` assembles the pieces of a specification into
one application. Every spec file must end with:

```ts
export default defineApp({ ... })
```

## Options

```ts
export default defineApp({
  name: "ExampleApp",       // required: the application name

  entities: [User],         // data model (from @spec/web)
  services: [MainAuth],     // behavior (from @spec/auth, ...)
  resources: [MainDB],      // infrastructure (from @spec/postgres, ...)
})
```

Only `name` is required; every collection is optional.

## What it produces

`defineApp` creates the root `app` node. Collections become both a name
list (membership) and node references in the IR:

```json
{
  "id": "app:ExampleApp",
  "kind": "app",
  "package": "@spec/core",
  "attributes": {
    "name": "ExampleApp",
    "entities": ["User"],
    "services": ["MainAuth"],
    "resources": ["MainDB"]
  }
}
```

Every node bound to a top-level `const` is included in the IR, whether or
not it appears in a collection — but only nodes listed in collections are
rendered by `spec inspect` and considered part of the application.

## Values passed must be spec nodes

`defineApp` validates its arguments eagerly. Passing a plain object or a
raw value:

```ts
export default defineApp({
  name: "Demo",
  entities: [{ id: "not-a-node" }], // ✗
})
```

produces:

```
SPEC_BUILDER_FAILED — Calling "@spec/core::defineApp" failed: defineApp:
"entities" contains a non-node value (use spec builders such as entity(...))
```

## A missing root is an error

A file without `export default defineApp(...)` reports:

```
SPEC_NO_APP — Specification must have `export default defineApp({...})`.
```

## Beyond the MVP

The root is deliberately minimal. Future phases can add fields (version
constraints, environments, feature flags, multi-app repositories) without
changing the shape of existing specifications — the IR is versioned for
exactly this reason.
