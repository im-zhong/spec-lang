---
layout: home

hero:
  name: spec
  text: Specification Programming in TypeScript
  tagline: Describe software in a restricted TypeScript DSL. Compile it to a deterministic Spec IR. Get structured diagnostics — a stable, verifiable foundation for AI-agent-driven software generation.
  actions:
    - theme: brand
      text: Get started
      link: /guide/quickstart
    - theme: alt
      text: Learn the concepts
      link: /guide/introduction
    - theme: alt
      text: Architecture
      link: /reference/architecture

features:
  - icon: 📝
    title: TypeScript as the host language
    details: Specifications are ordinary .spec.ts files. You keep type inference, editors and tooling — but the compiler reads the AST, it never executes your code.
  - icon: 📦
    title: Semantic packages
    details: Domain vocabulary (entity, auth, postgres) lives in packages that also carry validation rules and capabilities. Add @alice/spec-redis without touching the compiler.
  - icon: 🔒
    title: Deterministic Spec IR
    details: The same source, package and compiler versions always produce a byte-identical spec.ir.json — verified 100 compiles at a time.
  - icon: 🩺
    title: Structured diagnostics
    details: Every problem carries a code, level, source location and structured details. Diagnostics are a machine protocol for future agent-driven repair.
  - icon: 🔗
    title: Capability system
    details: Packages declare what they provide and require (Auth requires RelationalStore; Postgres provides it). The compiler links and checks them.
  - icon: 🧭
    title: Source traceability
    details: Every IR node points back to its file, line and column — the first link of the provenance chain from artifact back to specification.
---
