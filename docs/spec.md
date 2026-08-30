可以。下面这份我会按“**可以直接交给 Coding Agent 开始实现**”的粒度来写，重点限制第一阶段范围，避免 Agent 一上来把系统做得过大。

# Specification Programming MVP — Implementation Specification

## 1. Project Goal

实现一个基于 **TypeScript** 的 Specification Programming 原型系统。

项目核心目标不是创建一门新的语法语言，而是：

> 使用 TypeScript 作为宿主语言，通过一个受限制的 TypeScript DSL 描述软件 Specification；通过 Package 扩展不同领域能力；通过 Specification Compiler 将 Specification 编译为统一的中间表示，并为后续 AI Agent 生成软件提供稳定、可验证、可复现的输入。

第一阶段所有组件均使用 TypeScript 实现。

系统暂时命名为：

```text
spec
```

第一阶段 Specification 文件使用：

```text
*.spec.ts
```

例如：

```text
app.spec.ts
```

---

# 2. Core Design Principles

必须遵循以下设计原则。

## 2.1 TypeScript is the host language

Specification 使用 TypeScript 语法：

```ts
import {
  defineApp,
  entity,
  field,
} from "@spec/core"

const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
})

export default defineApp({
  entities: [User],
})
```

但是 Specification 不应被当作普通 JavaScript 程序执行。

Compiler 应优先通过：

```text
TypeScript Compiler API
```

读取：

```text
TypeScript Source
        ↓
TypeScript AST
        ↓
Spec AST / Spec IR
```

而不是：

```text
TypeScript
   ↓
Node.js execute
   ↓
runtime object
```

第一阶段可以允许部分简化实现，但整体架构必须为未来静态分析做好准备。

---

# 3. MVP Scope

第一阶段只实现以下能力：

```text
Spec Core
Package System
Web Package
Auth Package
Database Package
Spec Compiler
Spec IR
CLI
Validation
Artifact Output
```

暂时不实现：

```text
真正生成完整 Web 项目
真正执行 AI Agent
Formal Verification
TLA+
Lean
SMT
Distributed Package
IDE Plugin
LSP Server
Deployment
Package Registry
Remote Package Installation
```

但是架构必须允许未来加入这些模块。

---

# 4. High-Level Architecture

整体架构：

```text
                 app.spec.ts
                      │
                      ▼
            TypeScript Frontend
                      │
                      ▼
                 Spec AST
                      │
                      ▼
              Package Resolver
                      │
                      ▼
             Semantic Analysis
                      │
                      ▼
                  Spec IR
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
      Validator    Planner     Generator
          │                       │
          ▼                       ▼
     Diagnostics              Artifacts
```

MVP 实际实现：

```text
app.spec.ts
    ↓
Parser
    ↓
Spec IR
    ↓
Semantic Validator
    ↓
JSON Artifact
```

例如：

```bash
spec build app.spec.ts
```

输出：

```text
.spec/
├── spec.ir.json
├── diagnostics.json
└── manifest.json
```

---

# 5. Repository Structure

使用 pnpm workspace。

建议目录：

```text
spec/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
│
├── packages/
│   │
│   ├── core/
│   │   ├── src/
│   │   └── package.json
│   │
│   ├── compiler/
│   │   ├── src/
│   │   └── package.json
│   │
│   ├── cli/
│   │   ├── src/
│   │   └── package.json
│   │
│   ├── package-sdk/
│   │   ├── src/
│   │   └── package.json
│   │
│   ├── web/
│   │   ├── src/
│   │   └── package.json
│   │
│   ├── auth/
│   │   ├── src/
│   │   └── package.json
│   │
│   └── postgres/
│       ├── src/
│       └── package.json
│
├── examples/
│   └── basic-web-app/
│       └── app.spec.ts
│
└── tests/
```

Package names：

```text
@spec/core
@spec/compiler
@spec/cli
@spec/package-sdk

@spec/web
@spec/auth
@spec/postgres
```

---

# 6. Core Language Model

Core 不允许直接包含 Web、数据库、Auth 等领域概念。

Core 只提供通用 Specification 抽象。

第一阶段必须包含：

```text
SpecNode
SpecPackage
Capability
Reference
Constraint
Diagnostic
SourceLocation
SpecIR
```

---

# 7. SpecNode

所有 Specification 对象最终必须转换为：

```ts
interface SpecNode {
  id: string
  kind: string
  package: string
  name?: string

  attributes: Record<string, unknown>

  children?: SpecNode[]

  source?: SourceLocation
}
```

例如：

```ts
entity("User", {
  email: field.email(),
})
```

最终转换：

```json
{
  "id": "entity:user",
  "kind": "entity",
  "package": "@spec/web",
  "name": "User",
  "attributes": {},
  "children": []
}
```

---

# 8. Source Location

所有可追踪的 SpecNode 应尽可能记录：

```ts
interface SourceLocation {
  file: string
  line: number
  column: number
}
```

未来 Diagnostic 必须能够输出：

```text
app.spec.ts:14:5
```

因此 SourceLocation 必须成为架构一级概念。

---

# 9. Package Model

Specification Package 不是普通函数库。

一个 Package 应定义：

```text
Vocabulary
Semantics
Validation
Capabilities
Lowering
Future Agent Extensions
Future Verification Extensions
```

Package 接口：

```ts
interface SpecPackage {
  name: string
  version: string

  nodeKinds?: NodeKindDefinition[]

  capabilities?: CapabilityDefinition[]

  validators?: SpecValidator[]

  lowerings?: SpecLowering[]

  metadata?: Record<string, unknown>
}
```

---

# 10. NodeKindDefinition

```ts
interface NodeKindDefinition {
  kind: string

  validate?: (
    node: SpecNode,
    context: ValidationContext
  ) => Diagnostic[]
}
```

例如：

```text
@spec/auth
```

可以注册：

```text
auth
passwordStrategy
session
```

---

# 11. Package SDK

创建：

```text
@spec/package-sdk
```

用于领域 Package 作者开发自己的 Package。

至少提供：

```ts
definePackage(...)
defineNode(...)
defineCapability(...)
defineValidator(...)
defineLowering(...)
```

例如：

```ts
export default definePackage({
  name: "@spec/auth",
  version: "0.1.0",

  validators: [
    validateAuthPrincipal,
  ],
})
```

---

# 12. Capability System

Capability 是 Core 的一级概念。

用于表达 Package 之间的语义依赖。

例如：

```text
Auth package
     │
     │ requires
     ▼
UserStore
     ▲
     │ provides
     │
Postgres package
```

定义：

```ts
interface CapabilityDefinition {
  name: string
  package: string
}
```

IR 中支持：

```ts
interface CapabilityRequirement {
  capability: string
  requester: string
}
```

和：

```ts
interface CapabilityProvider {
  capability: string
  provider: string
}
```

Compiler 必须能够检查：

```text
requires capability
```

是否存在至少一个 provider。

---

# 13. Core DSL

Core package 提供：

```ts
defineApp()
defineSpec()
ref()
constraint()
```

例如：

```ts
import { defineApp } from "@spec/core"

export default defineApp({
  name: "Demo",
})
```

---

# 14. Web Package

创建：

```text
@spec/web
```

MVP 只提供：

```text
entity
field
page
api
```

其中重点实现：

```text
entity
field
```

---

# 15. Entity DSL

示例：

```ts
import {
  entity,
  field,
} from "@spec/web"

const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
  name: field.string(),
})
```

类型设计目标：

```ts
User.fields.id
User.fields.email
User.fields.name
```

可被 TypeScript 自动推断。

---

# 16. Field Types

第一阶段支持：

```text
string
int
boolean
uuid
email
datetime
```

例如：

```ts
field.string()
field.int()
field.boolean()
field.uuid()
field.email()
field.datetime()
```

Field modifiers：

```text
unique()
optional()
default(...)
```

设计成 chain API：

```ts
field.email()
  .unique()
  .optional()
```

---

# 17. Entity IR

例如：

```ts
const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
})
```

生成：

```json
{
  "kind": "entity",
  "package": "@spec/web",
  "name": "User",

  "attributes": {
    "fields": {
      "id": {
        "type": "uuid"
      },

      "email": {
        "type": "email",
        "unique": true
      }
    }
  }
}
```

---

# 18. Auth Package

创建：

```text
@spec/auth
```

提供：

```text
auth
password
```

示例：

```ts
import {
  auth,
  password,
} from "@spec/auth"

const MainAuth = auth({
  principal: User,

  strategy: password({
    identity: User.fields.email,
  }),
})
```

---

# 19. Auth Validation

Compiler 必须验证：

### principal 必须为 entity

错误：

```ts
auth({
  principal: "User",
})
```

如果不是合法 EntityReference，输出 Diagnostic。

### password identity 必须属于 principal

例如：

```ts
auth({
  principal: User,

  strategy: password({
    identity: Product.fields.id,
  }),
})
```

必须报错。

### identity 推荐为 unique field

如果：

```ts
User.fields.email
```

没有：

```ts
.unique()
```

产生 warning：

```text
AUTH_IDENTITY_NOT_UNIQUE
```

而不是 error。

---

# 20. PostgreSQL Package

创建：

```text
@spec/postgres
```

第一阶段只描述数据库 Provider，不真正创建 PostgreSQL。

提供：

```ts
postgres()
```

示例：

```ts
const MainDB = postgres({
  entities: [User],
})
```

Postgres package：

```text
provides:
  RelationalStore
  UserStore
```

或者第一阶段简化成：

```text
RelationalStore
```

Auth package 可以：

```text
requires:
  RelationalStore
```

---

# 21. Complete MVP Example

必须保证下面 Specification 可以成功编译：

```ts
import {
  defineApp,
} from "@spec/core"

import {
  entity,
  field,
} from "@spec/web"

import {
  auth,
  password,
} from "@spec/auth"

import {
  postgres,
} from "@spec/postgres"


const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
  name: field.string(),
})


const MainAuth = auth({
  principal: User,

  strategy: password({
    identity: User.fields.email,
  }),
})


const MainDB = postgres({
  entities: [User],
})


export default defineApp({
  name: "ExampleApp",

  entities: [
    User,
  ],

  services: [
    MainAuth,
  ],

  resources: [
    MainDB,
  ],
})
```

执行：

```bash
spec build examples/basic-web-app/app.spec.ts
```

必须输出成功。

---

# 22. Spec IR

定义统一顶层：

```ts
interface SpecIR {
  version: string

  app: {
    name: string
  }

  packages: PackageReference[]

  nodes: SpecNode[]

  capabilities: {
    required: CapabilityRequirement[]
    provided: CapabilityProvider[]
  }

  diagnostics: Diagnostic[]

  metadata: {
    compilerVersion: string
    generatedAt?: string
  }
}
```

注意：

`generatedAt` 不应参与 deterministic artifact hash。

---

# 23. IR Requirements

Spec IR 必须满足：

```text
Serializable
Stable
Versioned
Deterministic
Human-readable
Machine-readable
```

第一阶段使用：

```text
JSON
```

未来可以增加：

```text
Protobuf
```

但 MVP 不实现。

---

# 24. Deterministic Output

相同：

```text
Spec source
+
package versions
+
compiler version
```

必须产生相同的：

```text
spec.ir.json
```

除了明确标记为 nondeterministic metadata 的字段。

输出 JSON：

```text
keys 排序稳定
nodes 顺序稳定
IDs 稳定
```

禁止使用：

```text
random UUID
Date.now()
Math.random()
```

生成 IR identity。

Node ID 应根据：

```text
package
kind
name
source identity
```

确定性生成。

---

# 25. Diagnostics

定义：

```ts
type DiagnosticLevel =
  | "error"
  | "warning"
  | "info"

interface Diagnostic {
  code: string
  level: DiagnosticLevel

  message: string

  source?: SourceLocation

  nodeId?: string

  details?: Record<string, unknown>
}
```

例如：

```json
{
  "code": "AUTH_IDENTITY_NOT_UNIQUE",
  "level": "warning",
  "message": "Authentication identity User.email should be unique."
}
```

---

# 26. Structured Diagnostics Are Mandatory

不要只输出：

```text
Something went wrong.
```

所有错误必须有：

```text
code
level
message
location
structured details
```

原因：

未来 AI Agent 会直接消费 Diagnostic。

Architecture：

```text
Compiler
    ↓
Diagnostic
    ↓
Agent
    ↓
Repair
```

所以 Diagnostic 实际上也是机器协议。

---

# 27. Compiler Pipeline

Compiler 实现明确的 pass pipeline：

```text
Parse
  ↓
Resolve
  ↓
Normalize
  ↓
Validate
  ↓
Link
  ↓
Lower
  ↓
Emit
```

定义：

```ts
interface CompilerPass<Input, Output> {
  name: string

  run(
    input: Input,
    context: CompilerContext
  ): Promise<Output>
}
```

---

# 28. Compiler Context

```ts
interface CompilerContext {
  projectRoot: string

  packages: Map<string, SpecPackage>

  diagnostics: Diagnostic[]

  options: CompilerOptions
}
```

---

# 29. Package Resolution

MVP 直接使用 Node.js / pnpm package resolution。

Compiler 应能解析：

```ts
import { auth } from "@spec/auth"
```

对应的 package metadata。

暂时不实现自己的 registry。

---

# 30. Package Metadata

每个 Specification Package 在：

```json
package.json
```

增加：

```json
{
  "spec": {
    "package": true,
    "entry": "./dist/spec-package.js"
  }
}
```

Compiler 可以读取此 metadata。

---

# 31. TypeScript Restrictions

Specification 虽然使用 TypeScript，但不能支持所有 TypeScript。

MVP 定义允许的子集。

允许：

```text
import
export
const
object literal
array literal
string literal
number literal
boolean literal
identifier
property access
function call
```

例如：

```ts
const User = entity(...)
```

允许。

---

# 32. Forbidden Constructs

Specification 中禁止：

```text
while
do while
for
for await
eval
new Function
dynamic import
filesystem access
network access
process.env
Date.now
Math.random
arbitrary async execution
```

MVP Compiler 至少对明显的禁止语法产生错误。

例如：

```ts
for (const x of users) {
}
```

输出：

```text
SPEC_UNSUPPORTED_SYNTAX
```

---

# 33. Important Semantic Rule

Spec compiler 的语义来源必须是：

```text
source + static analysis
```

而不是执行用户 Specification。

第一阶段如果由于实现复杂度必须使用 Node.js 加载某些 package metadata：

允许执行：

```text
trusted package code
```

但禁止执行：

```text
untrusted user specification
```

长期架构必须保持此边界。

---

# 34. CLI

创建命令：

```bash
spec
```

MVP 支持：

```bash
spec check <file>
spec build <file>
spec inspect <file>
```

---

# 35. spec check

例如：

```bash
spec check app.spec.ts
```

只进行：

```text
parse
resolve
validate
link
```

不产生 artifact。

成功：

```text
✓ Specification valid
```

失败：

```text
✗ Specification invalid

AUTH_IDENTITY_NOT_UNIQUE
app.spec.ts:21:15

Authentication identity User.email should be unique.
```

exit code：

```text
0 = success
1 = specification error
2 = compiler/internal error
```

---

# 36. spec build

执行：

```bash
spec build app.spec.ts
```

生成：

```text
.spec/
├── spec.ir.json
├── manifest.json
└── diagnostics.json
```

成功：

```text
✓ Specification compiled
✓ IR written to .spec/spec.ir.json
```

---

# 37. spec inspect

```bash
spec inspect app.spec.ts
```

输出可读的 Specification Tree：

```text
Application ExampleApp

Entities
└── User
    ├── id: uuid
    ├── email: email [unique]
    └── name: string

Services
└── Auth
    ├── principal: User
    └── password
        └── identity: User.email

Resources
└── PostgreSQL
```

---

# 38. Manifest

输出：

```json
{
  "specVersion": "0.1",
  "compilerVersion": "0.1.0",

  "entry": "app.spec.ts",

  "packages": {
    "@spec/core": "0.1.0",
    "@spec/web": "0.1.0",
    "@spec/auth": "0.1.0",
    "@spec/postgres": "0.1.0"
  }
}
```

这个 manifest 是未来 reproducibility 的基础。

---

# 39. Agent Architecture Preparation

MVP 不实现 LLM Agent。

但必须提前定义：

```ts
interface AgentTask {
  id: string

  type: string

  input: unknown

  constraints: Constraint[]

  context: {
    specNodeIds: string[]
  }
}
```

以及：

```ts
interface AgentResult {
  taskId: string

  status:
    | "success"
    | "failure"

  artifacts?: Artifact[]

  diagnostics?: Diagnostic[]
}
```

暂时只定义接口。

---

# 40. Artifact Model

定义：

```ts
interface Artifact {
  id: string

  type:
    | "source"
    | "config"
    | "test"
    | "document"
    | "verification"

  path?: string

  contentHash?: string

  generatedBy?: string

  sourceNodes?: string[]
}
```

未来：

```text
SpecNode
   ↓
AgentTask
   ↓
Artifact
```

必须能够追踪 provenance。

---

# 41. Provenance

系统未来的重要目标是：

```text
Which specification produced this code?
```

因此设计必须支持：

```text
Artifact
    ↓
Agent Task
    ↓
Spec Node
    ↓
Source Location
```

MVP 至少保证：

```text
Spec IR Node → SourceLocation
```

可追踪。

---

# 42. Validation Layers

架构上区分：

```text
Layer 1
TypeScript syntax

Layer 2
Spec syntax restrictions

Layer 3
Spec core semantics

Layer 4
Package semantics

Layer 5
Cross-package semantics

Layer 6
Future formal verification
```

不要将所有 validation 混在一个函数中。

---

# 43. Web Package Validation

至少实现：

```text
duplicate entity names
duplicate field names
invalid field definitions
```

---

# 44. Auth Package Validation

至少实现：

```text
invalid principal
invalid identity
identity does not belong to principal
non-unique identity warning
```

---

# 45. Capability Validation

至少实现：

```text
missing capability provider
duplicate incompatible providers
```

第一阶段 duplicate provider 可以 warning。

---

# 46. Package Isolation

Compiler Core 不应：

```ts
if (node.kind === "auth") {
   ...
}
```

禁止在 Core Compiler 中硬编码领域逻辑。

必须：

```text
Auth-specific validation
```

位于：

```text
@spec/auth
```

Web-specific validation：

```text
@spec/web
```

Postgres-specific logic：

```text
@spec/postgres
```

Core compiler 只知道：

```text
Package
Node
Validator
Capability
Pass
```

这是一个关键 Acceptance Requirement。

---

# 47. Package Extension Example

系统设计必须允许未来第三方创建：

```text
@alice/spec-redis
```

而不修改：

```text
@spec/compiler
```

第三方：

```ts
export default definePackage({
  name: "@alice/spec-redis",

  capabilities: [
    provides("Cache"),
  ],

  validators: [
    ...
  ],

  lowerings: [
    ...
  ],
})
```

Compiler 能加载。

---

# 48. Testing Strategy

使用：

```text
Vitest
```

至少包含：

```text
unit tests
compiler tests
package tests
snapshot tests
integration tests
```

---

# 49. Golden Tests

建立：

```text
tests/fixtures/
```

例如：

```text
valid-basic-app/
invalid-auth-identity/
missing-database/
duplicate-entity/
unsupported-syntax/
```

每个测试：

```text
input spec
+
expected IR
+
expected diagnostics
```

---

# 50. Determinism Test

必须有测试：

连续编译同一个：

```text
app.spec.ts
```

100 次：

```text
SHA256(spec.ir.json)
```

必须一致。

---

# 51. Compiler Internal Errors

区分：

```text
User Error
```

和：

```text
Compiler Bug
```

用户 Spec 错误：

```text
Diagnostic
```

Compiler bug：

```text
InternalCompilerError
```

不要把 JS stack trace 默认暴露给最终用户。

允许：

```bash
spec build --debug
```

显示 stack trace。

---

# 52. Logging

统一 logger：

```ts
interface Logger {
  debug(...)
  info(...)
  warn(...)
  error(...)
}
```

不要在核心代码中随处：

```ts
console.log(...)
```

---

# 53. Configuration

支持：

```text
spec.config.ts
```

MVP 可以非常简单：

```ts
export default {
  outputDir: ".spec",
}
```

Compiler 默认：

```text
.spec
```

---

# 54. Versioning

所有 IR 必须带：

```text
version
```

例如：

```json
{
  "version": "spec-ir/0.1"
}
```

未来 breaking change：

```text
spec-ir/0.2
spec-ir/1.0
```

---

# 55. Security Boundary

必须明确区分：

```text
Trusted Compiler
Trusted Spec Packages
Untrusted User Specification
Future Untrusted Agent Output
```

第一阶段：

```text
Compiler 不执行用户 Specification
```

应该成为设计目标。

---

# 56. MVP Implementation Priority

按照以下顺序实现。

## Phase 1

```text
Monorepo
@spec/core
@spec/package-sdk
basic types
```

## Phase 2

```text
@spec/web
entity
field
```

## Phase 3

```text
compiler
TypeScript AST parsing
Spec extraction
Spec IR
```

## Phase 4

```text
validation
diagnostics
source location
```

## Phase 5

```text
@spec/auth
auth semantic validation
```

## Phase 6

```text
@spec/postgres
capability system
cross-package linking
```

## Phase 7

```text
CLI
check
build
inspect
```

## Phase 8

```text
deterministic build
golden tests
integration tests
```

---

# 57. Explicit Non-Goals

第一阶段不要实现：

```text
React code generation
Express/NestJS generation
database migrations
actual authentication
Docker
Kubernetes
LLM calls
Agent orchestration
distributed workflow engine
formal theorem proving
SMT
TLA+
Lean
package registry
VS Code extension
custom .spec grammar
custom parser
```

这些都属于后续阶段。

Coding Agent 不应主动扩展范围。

---

# 58. First Release Definition

第一个版本：

```text
0.1.0
```

完成标准：

用户可以创建：

```text
app.spec.ts
```

使用：

```text
@spec/web
@spec/auth
@spec/postgres
```

定义：

```text
User
Auth
Database
```

然后：

```bash
spec check app.spec.ts
```

成功完成静态语义检查。

再执行：

```bash
spec build app.spec.ts
```

得到 deterministic：

```text
.spec/spec.ir.json
```

并且：

```bash
spec inspect app.spec.ts
```

可以展示完整 Specification Tree。

---

# 59. Acceptance Test

以下代码：

```ts
import { defineApp } from "@spec/core"

import {
  entity,
  field,
} from "@spec/web"

import {
  auth,
  password,
} from "@spec/auth"

import {
  postgres,
} from "@spec/postgres"


const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
  name: field.string(),
})


const MainAuth = auth({
  principal: User,

  strategy: password({
    identity: User.fields.email,
  }),
})


const MainDB = postgres({
  entities: [User],
})


export default defineApp({
  name: "ExampleApp",

  entities: [
    User,
  ],

  services: [
    MainAuth,
  ],

  resources: [
    MainDB,
  ],
})
```

必须：

```bash
spec check app.spec.ts
```

返回：

```text
exit code 0
```

并且：

```bash
spec build app.spec.ts
```

生成：

```text
.spec/spec.ir.json
```

IR 至少能够表达：

```text
Application
User Entity
User Fields
Auth Service
Password Strategy
Authentication Identity
PostgreSQL Resource
Package Dependencies
Capabilities
Source Locations
```

---

# 60. Invalid Acceptance Test

以下代码：

```ts
const Product = entity("Product", {
  id: field.uuid(),
})


const MainAuth = auth({
  principal: User,

  strategy: password({
    identity: Product.fields.id,
  }),
})
```

必须产生：

```text
AUTH_IDENTITY_NOT_IN_PRINCIPAL
```

并：

```text
exit code 1
```

---

# 61. Architecture Constraints

实现过程中必须保持以下依赖方向：

```text
core
  ▲
  │
package-sdk
  ▲
  │
domain packages


core
  ▲
  │
compiler
  ▲
  │
cli
```

领域 package 不允许依赖 compiler 内部实现。

Compiler 不允许依赖具体 domain package 的源码。

Compiler 只能通过：

```text
SpecPackage interface
```

与 package 交互。

---

# 62. Future Architecture Compatibility

虽然 MVP 不实现，设计必须为以下能力保留扩展点：

```text
Agentic Compiler Pass

Formal Verification Pass

Package-specific Agent

Package-specific Verifier

Package-specific Generator

Incremental Compilation

Specification Linker

Remote Package Registry

Agent Runtime

Reproducible Software Build
```

未来希望形成：

```text
Specification
      │
      ▼
Compiler
      │
      ▼
Spec IR
      │
      ├── deterministic passes
      ├── agentic passes
      ├── verification passes
      └── lowering passes
      │
      ▼
Verified Reproducible Software
```

---

# 63. Core Conceptual Model

项目的核心不是：

```text
TypeScript DSL
```

本身。

核心模型是：

```text
Specification
      +
Semantic Packages
      ↓
Agentic Compiler
      ↓
Software Artifact
```

Package 应被理解为：

> A composable semantic compiler extension that encapsulates domain abstractions, semantic constraints, capabilities, validation rules, lowering rules, and future synthesis and verification behavior.

---

# 64. Final Engineering Principle

当设计发生冲突时，优先级如下：

```text
1. Stable semantics
2. Extensibility
3. Determinism
4. Structured diagnostics
5. Source traceability
6. Developer experience
7. Implementation simplicity
8. Performance
```

MVP 不追求性能优化。

首先保证 architecture 正确。

---

# 65. Deliverables

Coding Agent 最终需要交付：

```text
1. pnpm monorepo

2. @spec/core

3. @spec/package-sdk

4. @spec/compiler

5. @spec/cli

6. @spec/web

7. @spec/auth

8. @spec/postgres

9. working example

10. unit tests

11. integration tests

12. golden compiler tests

13. README

14. architecture documentation

15. CLI commands:
    spec check
    spec build
    spec inspect
```

最终必须能够：

```bash
pnpm install
pnpm build
pnpm test
```

全部成功。

并能够运行：

```bash
pnpm spec build examples/basic-web-app/app.spec.ts
```

得到稳定的：

```text
.spec/spec.ir.json
```

---

# 66. Definition of Done

只有满足以下全部条件才算 MVP 完成：

* TypeScript monorepo 能正常构建。
* Specification 使用 `.spec.ts`。
* 用户 Spec 不通过普通 Node.js runtime 执行。
* Compiler 能基于 TypeScript AST 提取 Specification。
* Core compiler 不包含 Web/Auth/Postgres 特殊判断。
* Package 可以注册自己的 semantic validator。
* Entity 和 Field 正常工作。
* Auth 能引用 Entity Field。
* PostgreSQL package 可以提供 capability。
* Compiler 可以检查 package capability dependency。
* Diagnostic 是结构化数据。
* Diagnostic 带源码位置。
* Spec IR 可以 JSON 序列化。
* Spec IR 是 deterministic 的。
* CLI 的 `check/build/inspect` 可用。
* 合法示例通过。
* 非法 Auth 示例被正确拒绝。
* 所有测试通过。
* README 可以让新开发者从零运行项目。

我建议你把这份直接作为 Coding Agent 的 **顶层 implementation spec**。第一版刻意没有让它碰 LLM、Agent Runtime 和形式化验证，先把 **Spec → Package → Compiler → IR → Diagnostic** 这条最核心的骨架做稳。等这个 MVP 跑起来后，第二阶段再加 `Agentic Compiler Pass`，整个系统会清晰很多。
