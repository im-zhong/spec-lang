---
layout: home

hero:
  name: spec
  text: Specification Programming in TypeScript
  tagline: Describe software in a restricted TypeScript DSL. Compile it to a deterministic Spec IR. Generate it with a coding agent — and prove the result behaves identically every time.
  actions:
    - theme: brand
      text: Get started
      link: /guide/quickstart
    - theme: alt
      text: Generate a backend
      link: /guide/generate
    - theme: alt
      text: The golden rule
      link: /guide/golden-rule

features:
  - icon: 📝
    title: TypeScript as the host language
    details: Specifications are ordinary .spec.ts files. You keep type inference, editors and tooling — but the compiler reads the AST, it never executes your code.
  - icon: 📦
    title: Semantic packages
    details: Domain vocabulary (entity, crud, auth, postgres, fastapi) lives in packages that also carry validation rules and capabilities. Add @alice/spec-redis without touching the compiler.
  - icon: 🔒
    title: Deterministic Spec IR
    details: The same source, package and compiler versions always produce a byte-identical spec.ir.json — verified 100 compiles at a time.
  - icon: 🤖
    title: Agentic generation
    details: spec generate lowers the IR to a pinned behavioral blueprint and lets a headless coding agent implement it — FastAPI backends today, more targets via the package interface.
  - icon: ⚖️
    title: The golden rule
    details: Same spec, several independent generations, identical behavior — same routes, same responses, same errors. Enforced by a compiler-owned conformance suite plus cross-shot OpenAPI equality.
  - icon: 🩺
    title: Structured diagnostics
    details: Every problem carries a code, level, source location and structured details — a machine protocol from static validation all the way to agent repair.
  - icon: 🔗
    title: Capability system
    details: Packages declare what they provide and require (Auth requires RelationalStore; Postgres provides it). The compiler links and checks them.
  - icon: 🧭
    title: Source traceability
    details: Every IR node points back to its file, line and column — and every generated file carries a content hash and the spec nodes it derives from.
---
