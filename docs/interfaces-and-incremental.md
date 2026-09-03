# Interfaces, parallel generation, and incremental invalidation

`interface` is a core spec-language concept, independent of HTTP, React,
FastAPI, modules, processes, or deployment topology. TypeScript reserves the
bare word, so source uses the namespaced keyword `spec.interface(...)`.

```ts
import { defineApp, spec } from "@spec/core"

const Media = spec.interface("Media", {
  protocol: "http-json",
  version: "1",
  operations: {
    list: {
      input: { cursor: "string?" },
      output: { items: [{ id: "uuid", title: "string" }] },
      transport: { method: "GET", path: "/media" },
    },
  },
})

const Backend = spec.module("backend", {
  target: "fastapi",
  provides: [Media],
  // contains: [BackendApi, Database], // private implementation inputs
})

const Frontend = spec.module("frontend", {
  target: "react",
  calls: [spec.call(Media, "list")],
})

export default defineApp({ name: "Media", modules: [Backend, Frontend] })
```

The compiler emits canonical interface definitions, SHA-256 hashes,
provide/call bindings, and provider-to-consumer invalidation edges in Spec IR
0.3. A call must resolve to exactly one provider and every selected operation
must exist. These are `spec check` errors, not agent decisions.

An interface edge is deliberately not a generation-order edge. Both sides
consume the same frozen interface and can be generated concurrently. The
module `inputHash` includes its declaration, the full IR of every `contains`
node, and every provided/called interface hash.
`planIncrementalGeneration(current, previous)` therefore follows these
rules:

- unchanged module input hash: reuse the prior generated checkpoint;
- changed interface: regenerate its provider and all direct callers in
  parallel;
- changed module internals behind an unchanged provided interface: regenerate
  only that module;
- removed modules are reported explicitly and never silently reused.

`planInterfaceModuleGeneration` then lowers only affected modules to target
generation roots. Every root has `dependsOn: []` and embeds the exact provided
and called interface definitions; the provider/caller relation remains an
invalidation edge, not a scheduler edge.

For an executable multi-target spec, `spec generate` uses the module graph as
a composite workspace plan. Each `fastapi` or `react` module is sliced to its
declared `contains` nodes and lowered independently into a directory named for
that module. Its task ids, cwd, write scopes, loop writers, seed files, and
oracle files are namespaced to that directory. All module roots depend only on
the same compiler-owned `.spec-interfaces/contracts.json`; they never depend
on one another. Their sinks join at one final compiler-owned conformance node,
so there is still exactly one golden-rule judgment per shot.

Once any module is declared, every concrete top-level implementation node must
appear in exactly one module's `contains`. Unknown nodes, boundary nodes
(`app`, `interface`, or another `module`), missing ownership, and overlapping
ownership are link errors. This makes isolation semantic instead of merely a
directory convention.

For `http-json`, every operation used by an executable composite plan must pin
`transport.method` and `transport.path`. Before starting an agent, lowering
checks that a FastAPI provider's blueprint actually exposes each declared
route. React callers receive a compiler-owned `src/spec-interface-client.ts`
derived from the same operation definitions. This prevents a module from
claiming to provide an interface that its generated API cannot implement.

The minimal end-to-end planning example is
`examples/interface-workspace/app.spec.ts`:

```bash
spec check examples/interface-workspace/app.spec.ts
spec generate examples/interface-workspace/app.spec.ts --dry-run
```

The dry-run artifact `.spec/composite.agent.tasks.json` records module input
and interface hashes, disjoint working directories/scopes, prompt hashes,
verification commands, and the combined evidence surface.

This applies at any scale: two files, packages in a monolith, frontend/backend,
or independently deployed services. Coupled implementation details must not be
smuggled through an interface; if two units need those details, they are one
generation unit until the contract is made explicit.
