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
    details: Domain vocabulary and providers (web, auth, Postgres, cache/Redis, messaging/RabbitMQ/Kafka/SQS, blob/S3, FastAPI) carry validation, capabilities and deterministic generation guidance without compiler domain logic.
  - icon: 🔒
    title: Deterministic Spec IR
    details: The same source, package and compiler versions always produce a byte-identical spec.ir.json — verified 100 compiles at a time.
  - icon: 🤖
    title: Agentic generation
    details: spec generate lowers the IR to a pinned behavioral blueprint and lets a headless coding agent implement it — FastAPI backends today, more targets via the package interface.
  - icon: ⚖️
    title: The golden rule
    details: Same spec, parallel independent generations, identical behavior — real HTTP and infrastructure contracts. Enforced by a compiler-owned runtime suite plus cross-shot OpenAPI and behavior snapshots.
  - icon: 🩺
    title: Structured diagnostics
    details: Every problem carries a code, level, source location and structured details — one machine protocol for static compilation, generation, verification and repeatability verdicts.
  - icon: 🔗
    title: Capability system
    details: Packages declare what they provide and require (Auth requires RelationalStore; Postgres provides it). The compiler links and checks them.
  - icon: 🧭
    title: Source traceability
    details: Every IR node points back to its file, line and column — and every generated file carries a content hash and the spec nodes it derives from.
---
