# StorePlatform — agent prompt 回放手册（clause-driven v2 契约）

本手册由脚本从归档执行计划确定性导出（无时间戳、无环境相关值），
包含回放该 run 所需的**全部运行时 prompt**。

## 来源与拼装规则

- 执行计划：`../../../../tmp/store-platform-v02-plan.json`（run `clause-driven-replay`，仓库 `im-zhong/spec-store-platform`，fingerprint `sha256:6a8100b3743e21bdf5f5520dc104c432909fdb958c227eb0aa8e080b75799832`）
- 执行环境：镜像 `ghcr.io/im-zhong/spec-agent@sha256:bf8fbf251eeecc81a3fc9f98795cb265b6af62cdbe957cd4f7a5c3b6018a61e8`；模型 `glm-5.3-flash`，effort `medium`，turn 上限 `100`，并发上限 `4`
- Prompt 拼装公式与 `packages/execution/src/docker.ts:296-357` 逐字节一致：
  - 上下文块 = 角色指令 + `# Frozen node context` 块 + 所有权行（见下文公式）
  - 第 2 轮起，仅上下文块中的轮次号与 `Reviewer feedback from the prior round:` 段变化，其余逐字节不变
- 重新生成本文件：`node scripts/export-agent-prompts.mjs <plan.json> <out.md>`；脚本写完后会回读校验每个逐字 prompt

## 回放方法

循环 v0.2：每轮**单个实现 agent 直接在任务目录执行**（无快照目录），随后只读评审在任务目录执行。prompt 一律经 **stdin** 传入（`claude … < prompt.txt`）。编译器物化的节点 oracle（`tests/spec_oracle/`）随 compiler-seed 落盘，任何 agent 不可编辑；评审与验收命令运行它。若实现 agent 认为契约有缺陷，输出 \`{"challenge":{...}}\` 即终止 run（spec 缺陷，golden-rule 响应）。

writer（实现 agent）：

````bash
claude -p --output-format json --safe-mode --no-session-persistence --permission-mode acceptEdits --model glm-5.3-flash --effort medium --max-turns 100 --allowedTools Read Glob Grep LS Edit Write Bash(uv:*) Bash(python:*) Bash(python3:*) Bash(.venv/bin/python:*) Bash(pytest:*) Bash(ls:*) Bash(cat:*) Bash(head:*) Bash(tail:*) Bash(wc:*) Bash(grep:*) Bash(find:*) Bash(mkdir:*) Bash(sed:*)
````

评审（只读，permission-mode plan）：

````bash
claude -p --output-format json --safe-mode --no-session-persistence --permission-mode plan --model glm-5.3-flash --effort medium --max-turns 100 --allowedTools Read Glob Grep LS Bash(uv:*) Bash(python:*) Bash(python3:*) Bash(.venv/bin/python:*) Bash(pytest:*) Bash(ls:*) Bash(cat:*) Bash(head:*) Bash(tail:*) Bash(wc:*) Bash(grep:*) Bash(find:*) Bash(sed:*)
````

CWD 规则（容器内路径，任务目录 = `/workspace/<workingDirectory>`）：

- 实现 agent：`/workspace/<workingDirectory>`（任务目录本身，v0.2 无快照目录）
- 评审 agent：`/workspace/<workingDirectory>`（任务目录本身，只读）
- 其中 `<safeTaskId>` = 任务 id 小写并把非 `[a-z0-9_.-]` 字符替换为 `-`（docker.ts `safeName`）

## 逐字 prompt 公式

下列公式即 docker.ts 的运行时拼装（`R` = 轮次，`FB` = 上一轮评审 feedback 的逐字内容）：

````text
实现 agent stdin = loop.implementation.instruction
  + "\n\n# Frozen node context\nTask: <id>\nRound: R/<maxRounds>\n"
  + (R == 1 ? "This is the first round.\n"
            : "Reviewer feedback from the prior round:\n<FB>\n")
  + "\nYou own only: <implementation.scope 逗号连接>."

评审 agent stdin = loop.reviewer.instruction + 同一上下文块
  + "\nReview the implementation against the frozen node contract and its clause table. The machine evidence is:
"  + <TEST_EVIDENCE>
  + "\nDo not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {\"approved\":boolean,\"feedback\":\"specific changes keyed to clause ids where applicable\"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection."

<TEST_EVIDENCE> = 每条评审命令的 "$ <命令>\nexit=<exitCode>\n<stdout>\n<stderr>" 以空行连接（运行时数据，即编译器 oracle 的输出）
````

评审输出必须**只**是那个 JSON 对象；解析见 docker.ts `parseAgentEnvelope`。未获 approved 则进入下一轮；轮次耗尽即任务失败（无修复回路）。挑战协议：实现 agent 的 result 若为 {"challenge":{"clause":…,"reason":…}}，run 以 SPEC_CONTRACT_CHALLENGED 终止，不重试。

## 执行顺序总览

| 层 | 节点 | 类型 | 说明 |
| --- | --- | --- | --- |
| 0 | `compiler-seed` | materialize（非 agent） | materialize compiler-owned generation inputs |
| 1 | `orders-project` | agent（≤3 轮 单writer/评审回路，v0.2） | orders: project skeleton |
| 1 | `reporting-project` | agent（≤3 轮 单writer/评审回路，v0.2） | reporting: project skeleton |
| 1 | `warehouse-project` | agent（≤3 轮 单writer/评审回路，v0.2） | warehouse: project skeleton |
| 2 | `orders-database` | agent（≤3 轮 单writer/评审回路，v0.2） | orders: database layer |
| 2 | `orders-models` | agent（≤3 轮 单writer/评审回路，v0.2） | orders: data models |
| 2 | `reporting-database` | agent（≤3 轮 单writer/评审回路，v0.2） | reporting: database layer |
| 2 | `reporting-models` | agent（≤3 轮 单writer/评审回路，v0.2） | reporting: data models |
| 2 | `warehouse-database` | agent（≤3 轮 单writer/评审回路，v0.2） | warehouse: database layer |
| 2 | `warehouse-models` | agent（≤3 轮 单writer/评审回路，v0.2） | warehouse: data models |
| 3 | `orders-schemas` | agent（≤3 轮 单writer/评审回路，v0.2） | orders: pydantic schemas |
| 3 | `reporting-schemas` | agent（≤3 轮 单writer/评审回路，v0.2） | reporting: pydantic schemas |
| 3 | `warehouse-schemas` | agent（≤3 轮 单writer/评审回路，v0.2） | warehouse: pydantic schemas |
| 4 | `orders-router-Order` | agent（≤3 轮 单writer/评审回路，v0.2） | orders: router: Order |
| 4 | `reporting-router-Report` | agent（≤3 轮 单writer/评审回路，v0.2） | reporting: router: Report |
| 4 | `warehouse-router-Item` | agent（≤3 轮 单writer/评审回路，v0.2） | warehouse: router: Item |
| 5 | `orders-app` | agent（≤3 轮 单writer/评审回路，v0.2） | orders: application wiring |
| 5 | `reporting-app` | agent（≤3 轮 单writer/评审回路，v0.2） | reporting: application wiring |
| 5 | `warehouse-app` | agent（≤3 轮 单writer/评审回路，v0.2） | warehouse: application wiring |
| 6 | `conformance` | materialize（非 agent） | materialize and run the compiler-owned conformance oracle |

## 第 0 层 · materialize（非 agent）

### 节点 `compiler-seed` — materialize compiler-owned generation inputs

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace`；容器内：`/workspace/products/storeplatform/workspace`
- 依赖：—
- instruction："Materialize compiler-owned seed files exactly."
- 物化文件（27 个，内容见 plan.json 的 `materializedFiles`，逐字写入任务目录）：

````
.spec-interfaces/contracts.json
orders/app/router_registry.py
orders/app/spec_interface_client.py
orders/tests/spec_oracle/runner.py
orders/tests/spec_oracle/test_app.py
orders/tests/spec_oracle/test_database.py
orders/tests/spec_oracle/test_models.py
orders/tests/spec_oracle/test_project.py
orders/tests/spec_oracle/test_router_order.py
orders/tests/spec_oracle/test_schemas.py
reporting/app/router_registry.py
reporting/app/spec_interface_client.py
reporting/tests/spec_oracle/runner.py
reporting/tests/spec_oracle/test_app.py
reporting/tests/spec_oracle/test_database.py
reporting/tests/spec_oracle/test_models.py
reporting/tests/spec_oracle/test_project.py
reporting/tests/spec_oracle/test_router_report.py
reporting/tests/spec_oracle/test_schemas.py
warehouse/app/router_registry.py
warehouse/tests/spec_oracle/runner.py
warehouse/tests/spec_oracle/test_app.py
warehouse/tests/spec_oracle/test_database.py
warehouse/tests/spec_oracle/test_models.py
warehouse/tests/spec_oracle/test_project.py
warehouse/tests/spec_oracle/test_router_item.py
warehouse/tests/spec_oracle/test_schemas.py
````

- 验收命令：

````bash
true
````


## 第 1 层 · 3 个 agent 节点（可并行）

### 节点 `orders-project` — orders: project skeleton

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/orders`；容器内：`/workspace/products/storeplatform/workspace/orders`
- 依赖：`compiler-seed`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`942998d02f508e0e69de78ac3c0826176e5007005c94a77643d929d2b8a1e597`
- 评审 instruction sha256：`5289a5a72971bce739e6f94b7b09f1603b5a43f8ee607bd8976170d1556e2559`
- spec 节点：`app:StorePlatform`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_project.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: project skeleton

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): pyproject.toml, app/__init__.py, .gitignore
- Already generated by previous tasks (read-only for you): —
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [file:app-package] The package directory app/ exists with app/__init__.py.
- [file:gitignore] .gitignore covers bytecode caches and virtualenvs.
- [pin:pyproject:dependencies] dependencies is EXACTLY the pinned set [bcrypt==5.0.0, email-validator==2.2.0, fastapi==0.141.1, pydantic-settings==2.15.0, pydantic==2.13.5, pyjwt==2.13.0, sqlalchemy==2.0.52, uvicorn==0.52.4] — no additions, removals, or floated versions.
- [pin:pyproject:dev-dependencies] [project.optional-dependencies] dev is EXACTLY [httpx==0.28.1, pytest==9.1.1].
- [pin:pyproject:name] pyproject.toml declares project name "storeplatform".
- [pin:pyproject:no-passlib] passlib is never a dependency (it crashes with bcrypt >= 5; bcrypt is already pinned).
- [pin:pyproject:requires-python] requires-python is exactly "==3.13.*".
- [pin:pyproject:version] pyproject.toml declares version "0.1.0".


## Forbidden extras
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### App metadata
```json
{
  "name": "StorePlatform",
  "port": 8000,
  "prefix": "/api",
  "title": "Orders API",
  "version": "0.1.0"
}
```

## Engineering notes
- pyproject.toml must be installable (hatchling or setuptools).

# Frozen node context
Task: orders-project
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/orders/.gitignore, products/storeplatform/workspace/orders/app/__init__.py, products/storeplatform/workspace/orders/pyproject.toml.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "project".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [file:app-package] The package directory app/ exists with app/__init__.py.
- [file:gitignore] .gitignore covers bytecode caches and virtualenvs.
- [pin:pyproject:dependencies] dependencies is EXACTLY the pinned set [bcrypt==5.0.0, email-validator==2.2.0, fastapi==0.141.1, pydantic-settings==2.15.0, pydantic==2.13.5, pyjwt==2.13.0, sqlalchemy==2.0.52, uvicorn==0.52.4] — no additions, removals, or floated versions.
- [pin:pyproject:dev-dependencies] [project.optional-dependencies] dev is EXACTLY [httpx==0.28.1, pytest==9.1.1].
- [pin:pyproject:name] pyproject.toml declares project name "storeplatform".
- [pin:pyproject:no-passlib] passlib is never a dependency (it crashes with bcrypt >= 5; bcrypt is already pinned).
- [pin:pyproject:requires-python] requires-python is exactly "==3.13.*".
- [pin:pyproject:version] pyproject.toml declares version "0.1.0".

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: orders-project
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: orders-project
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

### 节点 `reporting-project` — reporting: project skeleton

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/reporting`；容器内：`/workspace/products/storeplatform/workspace/reporting`
- 依赖：`compiler-seed`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`533fe4afeef35b41cdbe557bfddb19990c1b12445ea4139dd06f43c887376916`
- 评审 instruction sha256：`5289a5a72971bce739e6f94b7b09f1603b5a43f8ee607bd8976170d1556e2559`
- spec 节点：`app:StorePlatform`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_project.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: project skeleton

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): pyproject.toml, app/__init__.py, .gitignore
- Already generated by previous tasks (read-only for you): —
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [file:app-package] The package directory app/ exists with app/__init__.py.
- [file:gitignore] .gitignore covers bytecode caches and virtualenvs.
- [pin:pyproject:dependencies] dependencies is EXACTLY the pinned set [bcrypt==5.0.0, email-validator==2.2.0, fastapi==0.141.1, pydantic-settings==2.15.0, pydantic==2.13.5, pyjwt==2.13.0, sqlalchemy==2.0.52, uvicorn==0.52.4] — no additions, removals, or floated versions.
- [pin:pyproject:dev-dependencies] [project.optional-dependencies] dev is EXACTLY [httpx==0.28.1, pytest==9.1.1].
- [pin:pyproject:name] pyproject.toml declares project name "storeplatform".
- [pin:pyproject:no-passlib] passlib is never a dependency (it crashes with bcrypt >= 5; bcrypt is already pinned).
- [pin:pyproject:requires-python] requires-python is exactly "==3.13.*".
- [pin:pyproject:version] pyproject.toml declares version "0.1.0".


## Forbidden extras
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### App metadata
```json
{
  "name": "StorePlatform",
  "port": 8000,
  "prefix": "/api",
  "title": "Reporting API",
  "version": "0.1.0"
}
```

## Engineering notes
- pyproject.toml must be installable (hatchling or setuptools).

# Frozen node context
Task: reporting-project
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/reporting/.gitignore, products/storeplatform/workspace/reporting/app/__init__.py, products/storeplatform/workspace/reporting/pyproject.toml.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "project".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [file:app-package] The package directory app/ exists with app/__init__.py.
- [file:gitignore] .gitignore covers bytecode caches and virtualenvs.
- [pin:pyproject:dependencies] dependencies is EXACTLY the pinned set [bcrypt==5.0.0, email-validator==2.2.0, fastapi==0.141.1, pydantic-settings==2.15.0, pydantic==2.13.5, pyjwt==2.13.0, sqlalchemy==2.0.52, uvicorn==0.52.4] — no additions, removals, or floated versions.
- [pin:pyproject:dev-dependencies] [project.optional-dependencies] dev is EXACTLY [httpx==0.28.1, pytest==9.1.1].
- [pin:pyproject:name] pyproject.toml declares project name "storeplatform".
- [pin:pyproject:no-passlib] passlib is never a dependency (it crashes with bcrypt >= 5; bcrypt is already pinned).
- [pin:pyproject:requires-python] requires-python is exactly "==3.13.*".
- [pin:pyproject:version] pyproject.toml declares version "0.1.0".

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: reporting-project
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: reporting-project
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

### 节点 `warehouse-project` — warehouse: project skeleton

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/warehouse`；容器内：`/workspace/products/storeplatform/workspace/warehouse`
- 依赖：`compiler-seed`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`39514def3fd850dcd0ede135677373f9c7f045afb4b162f8f4d6ff0d22d966fb`
- 评审 instruction sha256：`5289a5a72971bce739e6f94b7b09f1603b5a43f8ee607bd8976170d1556e2559`
- spec 节点：`app:StorePlatform`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_project.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: project skeleton

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): pyproject.toml, app/__init__.py, .gitignore
- Already generated by previous tasks (read-only for you): —
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [file:app-package] The package directory app/ exists with app/__init__.py.
- [file:gitignore] .gitignore covers bytecode caches and virtualenvs.
- [pin:pyproject:dependencies] dependencies is EXACTLY the pinned set [bcrypt==5.0.0, email-validator==2.2.0, fastapi==0.141.1, pydantic-settings==2.15.0, pydantic==2.13.5, pyjwt==2.13.0, sqlalchemy==2.0.52, uvicorn==0.52.4] — no additions, removals, or floated versions.
- [pin:pyproject:dev-dependencies] [project.optional-dependencies] dev is EXACTLY [httpx==0.28.1, pytest==9.1.1].
- [pin:pyproject:name] pyproject.toml declares project name "storeplatform".
- [pin:pyproject:no-passlib] passlib is never a dependency (it crashes with bcrypt >= 5; bcrypt is already pinned).
- [pin:pyproject:requires-python] requires-python is exactly "==3.13.*".
- [pin:pyproject:version] pyproject.toml declares version "0.1.0".


## Forbidden extras
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### App metadata
```json
{
  "name": "StorePlatform",
  "port": 8000,
  "prefix": "/api",
  "title": "Warehouse API",
  "version": "0.1.0"
}
```

## Engineering notes
- pyproject.toml must be installable (hatchling or setuptools).

# Frozen node context
Task: warehouse-project
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/warehouse/.gitignore, products/storeplatform/workspace/warehouse/app/__init__.py, products/storeplatform/workspace/warehouse/pyproject.toml.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "project".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [file:app-package] The package directory app/ exists with app/__init__.py.
- [file:gitignore] .gitignore covers bytecode caches and virtualenvs.
- [pin:pyproject:dependencies] dependencies is EXACTLY the pinned set [bcrypt==5.0.0, email-validator==2.2.0, fastapi==0.141.1, pydantic-settings==2.15.0, pydantic==2.13.5, pyjwt==2.13.0, sqlalchemy==2.0.52, uvicorn==0.52.4] — no additions, removals, or floated versions.
- [pin:pyproject:dev-dependencies] [project.optional-dependencies] dev is EXACTLY [httpx==0.28.1, pytest==9.1.1].
- [pin:pyproject:name] pyproject.toml declares project name "storeplatform".
- [pin:pyproject:no-passlib] passlib is never a dependency (it crashes with bcrypt >= 5; bcrypt is already pinned).
- [pin:pyproject:requires-python] requires-python is exactly "==3.13.*".
- [pin:pyproject:version] pyproject.toml declares version "0.1.0".

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: warehouse-project
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: warehouse-project
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

## 第 2 层 · 6 个 agent 节点（可并行）

### 节点 `orders-database` — orders: database layer

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/orders`；容器内：`/workspace/products/storeplatform/workspace/orders`
- 依赖：`orders-project`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`e5f28296bb56c98763bf07557576580aeaacdaaac978374e20cb0a54d182d5e6`
- 评审 instruction sha256：`a8ee676f82a464284907411b9a7d2071be495e79b7b975a4ee8368c493db9024`
- spec 节点：`postgres:OrdersDb`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_database.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: database layer

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/config.py, app/database.py
- Already generated by previous tasks (read-only for you): app/__init__.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [abi:app:config:exports] app/config.py exports only a pydantic-settings Settings class whose optional database_url field reads DATABASE_URL; it reads no dotenv file and instantiates no settings at module import.
- [abi:app:database:exports] app/database.py exports exactly Base, normalize_database_url(value), resolve_database_url(explicit=None), create_engine_from_url(explicit=None), create_session_factory(engine), module defaults engine and SessionLocal, get_db(), and session_dependency(factory).
- [review:app:database:no-extra-apis] (reviewer-judged) app/config.py and app/database.py add no caches, registries, dotenv support, lazy module attributes, or APIs beyond the declared exports.

### function-level clauses
- [database:get-db] get_db yields from the module-default SessionLocal and always closes the session; session_dependency(factory) returns the same yielding dependency bound to the supplied factory.
- [database:sessionmaker] create_session_factory(engine) returns a synchronous sessionmaker with autoflush=False and expire_on_commit=False.
- [database:sqlite-engine] SQLite engines use check_same_thread=False; in-memory SQLite additionally uses StaticPool.
- [database:url-resolution] URL resolution order is pinned: explicit argument → DATABASE_URL env → "sqlite:///./dev.db"; values are ALWAYS SQLAlchemy URLs; a non-empty bare path normalizes to sqlite:///<path>; an empty string uses the fallback.

## Forbidden extras
- The module's public surface is exactly the declared export list — no additional APIs, registries, or framework code.
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Database contract
```json
{
  "engine": "postgres",
  "fallback": "sqlite:///./dev.db",
  "urlEnv": "DATABASE_URL",
  "urlFormat": "sqlalchemy-url"
}
```

## Engineering notes
- Base is the one SQLAlchemy DeclarativeBase imported by models.
- Tables are created via Base.metadata.create_all(engine) at app startup (the app task wires this).

# Frozen node context
Task: orders-database
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/orders/app/config.py, products/storeplatform/workspace/orders/app/database.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "database".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [abi:app:config:exports] app/config.py exports only a pydantic-settings Settings class whose optional database_url field reads DATABASE_URL; it reads no dotenv file and instantiates no settings at module import.
- [abi:app:database:exports] app/database.py exports exactly Base, normalize_database_url(value), resolve_database_url(explicit=None), create_engine_from_url(explicit=None), create_session_factory(engine), module defaults engine and SessionLocal, get_db(), and session_dependency(factory).
- [database:get-db] get_db yields from the module-default SessionLocal and always closes the session; session_dependency(factory) returns the same yielding dependency bound to the supplied factory.
- [database:sessionmaker] create_session_factory(engine) returns a synchronous sessionmaker with autoflush=False and expire_on_commit=False.
- [database:sqlite-engine] SQLite engines use check_same_thread=False; in-memory SQLite additionally uses StaticPool.
- [database:url-resolution] URL resolution order is pinned: explicit argument → DATABASE_URL env → "sqlite:///./dev.db"; values are ALWAYS SQLAlchemy URLs; a non-empty bare path normalizes to sqlite:///<path>; an empty string uses the fallback.

## Reviewer-judged clauses (verify by inspection)
- [review:app:database:no-extra-apis] app/config.py and app/database.py add no caches, registries, dotenv support, lazy module attributes, or APIs beyond the declared exports.

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: orders-database
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: orders-database
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

### 节点 `orders-models` — orders: data models

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/orders`；容器内：`/workspace/products/storeplatform/workspace/orders`
- 依赖：`orders-project`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`bbd59118d743eff9ac8b15a8b1f6f116c9c2bfbc7db2d7b4a0de9b26fa80ffd0`
- 评审 instruction sha256：`b06d3b68fd4cd44d3077cffc56dfb4b21ff35f32149b808420e1df0d770aeef9`
- spec 节点：`entity:Order`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_models.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: data models

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/models.py
- Already generated by previous tasks (read-only for you): app/__init__.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [entity:Order:column:created_at] created_at is a naive-UTC datetime column set once on insert, present on every entity.
- [entity:Order:column:id] id is a uuid column
- [entity:Order:column:quantity] quantity is a int column, storing the declared default 1 when omitted at insert
- [entity:Order:column:reference] reference is a string column, with a unique constraint
- [entity:Order:column:status] status is a string column validated against {"placed", "fulfilled", "cancelled"}, storing the declared default "placed" when omitted at insert
- [entity:Order:table] Class Order declares __tablename__ "orders" with the declared column set.


## Forbidden extras
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Entities (the complete data model)
```json
[
  {
    "fields": [
      {
        "column": "id",
        "name": "id",
        "type": "uuid"
      },
      {
        "column": "quantity",
        "default": 1,
        "name": "quantity",
        "type": "int"
      },
      {
        "column": "reference",
        "name": "reference",
        "type": "string",
        "unique": true
      },
      {
        "column": "status",
        "default": "placed",
        "name": "status",
        "states": [
          "placed",
          "fulfilled",
          "cancelled"
        ],
        "type": "enum"
      }
    ],
    "name": "Order",
    "table": "orders"
  }
]
```

## Engineering notes
- One class per entity; a shared mixin for id/created_at is idiomatic.
- The uuid4 default may be Python-side; it must produce distinct ids per insert.
- No auth in this specification: no password columns.

# Frozen node context
Task: orders-models
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/orders/app/models.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "models".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [entity:Order:column:created_at] created_at is a naive-UTC datetime column set once on insert, present on every entity.
- [entity:Order:column:id] id is a uuid column
- [entity:Order:column:quantity] quantity is a int column, storing the declared default 1 when omitted at insert
- [entity:Order:column:reference] reference is a string column, with a unique constraint
- [entity:Order:column:status] status is a string column validated against {"placed", "fulfilled", "cancelled"}, storing the declared default "placed" when omitted at insert
- [entity:Order:table] Class Order declares __tablename__ "orders" with the declared column set.

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: orders-models
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: orders-models
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

### 节点 `reporting-database` — reporting: database layer

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/reporting`；容器内：`/workspace/products/storeplatform/workspace/reporting`
- 依赖：`reporting-project`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`e5f28296bb56c98763bf07557576580aeaacdaaac978374e20cb0a54d182d5e6`
- 评审 instruction sha256：`a8ee676f82a464284907411b9a7d2071be495e79b7b975a4ee8368c493db9024`
- spec 节点：`postgres:ReportingDb`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_database.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: database layer

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/config.py, app/database.py
- Already generated by previous tasks (read-only for you): app/__init__.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [abi:app:config:exports] app/config.py exports only a pydantic-settings Settings class whose optional database_url field reads DATABASE_URL; it reads no dotenv file and instantiates no settings at module import.
- [abi:app:database:exports] app/database.py exports exactly Base, normalize_database_url(value), resolve_database_url(explicit=None), create_engine_from_url(explicit=None), create_session_factory(engine), module defaults engine and SessionLocal, get_db(), and session_dependency(factory).
- [review:app:database:no-extra-apis] (reviewer-judged) app/config.py and app/database.py add no caches, registries, dotenv support, lazy module attributes, or APIs beyond the declared exports.

### function-level clauses
- [database:get-db] get_db yields from the module-default SessionLocal and always closes the session; session_dependency(factory) returns the same yielding dependency bound to the supplied factory.
- [database:sessionmaker] create_session_factory(engine) returns a synchronous sessionmaker with autoflush=False and expire_on_commit=False.
- [database:sqlite-engine] SQLite engines use check_same_thread=False; in-memory SQLite additionally uses StaticPool.
- [database:url-resolution] URL resolution order is pinned: explicit argument → DATABASE_URL env → "sqlite:///./dev.db"; values are ALWAYS SQLAlchemy URLs; a non-empty bare path normalizes to sqlite:///<path>; an empty string uses the fallback.

## Forbidden extras
- The module's public surface is exactly the declared export list — no additional APIs, registries, or framework code.
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Database contract
```json
{
  "engine": "postgres",
  "fallback": "sqlite:///./dev.db",
  "urlEnv": "DATABASE_URL",
  "urlFormat": "sqlalchemy-url"
}
```

## Engineering notes
- Base is the one SQLAlchemy DeclarativeBase imported by models.
- Tables are created via Base.metadata.create_all(engine) at app startup (the app task wires this).

# Frozen node context
Task: reporting-database
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/reporting/app/config.py, products/storeplatform/workspace/reporting/app/database.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "database".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [abi:app:config:exports] app/config.py exports only a pydantic-settings Settings class whose optional database_url field reads DATABASE_URL; it reads no dotenv file and instantiates no settings at module import.
- [abi:app:database:exports] app/database.py exports exactly Base, normalize_database_url(value), resolve_database_url(explicit=None), create_engine_from_url(explicit=None), create_session_factory(engine), module defaults engine and SessionLocal, get_db(), and session_dependency(factory).
- [database:get-db] get_db yields from the module-default SessionLocal and always closes the session; session_dependency(factory) returns the same yielding dependency bound to the supplied factory.
- [database:sessionmaker] create_session_factory(engine) returns a synchronous sessionmaker with autoflush=False and expire_on_commit=False.
- [database:sqlite-engine] SQLite engines use check_same_thread=False; in-memory SQLite additionally uses StaticPool.
- [database:url-resolution] URL resolution order is pinned: explicit argument → DATABASE_URL env → "sqlite:///./dev.db"; values are ALWAYS SQLAlchemy URLs; a non-empty bare path normalizes to sqlite:///<path>; an empty string uses the fallback.

## Reviewer-judged clauses (verify by inspection)
- [review:app:database:no-extra-apis] app/config.py and app/database.py add no caches, registries, dotenv support, lazy module attributes, or APIs beyond the declared exports.

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: reporting-database
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: reporting-database
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

### 节点 `reporting-models` — reporting: data models

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/reporting`；容器内：`/workspace/products/storeplatform/workspace/reporting`
- 依赖：`reporting-project`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`297861a15c79ae18bb6e2fe66741d828de4467132378d25253ee755b88cf1931`
- 评审 instruction sha256：`df761f99b1870e741a6b24fadf90e59a4abb171d2d580a788d7f1902d9acfb6a`
- spec 节点：`entity:Report`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_models.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: data models

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/models.py
- Already generated by previous tasks (read-only for you): app/__init__.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [entity:Report:column:created_at] created_at is a naive-UTC datetime column set once on insert, present on every entity.
- [entity:Report:column:id] id is a uuid column
- [entity:Report:column:metric] metric is a string column validated against {"orders", "stock"}
- [entity:Report:column:ready] ready is a boolean column, storing the declared default false when omitted at insert
- [entity:Report:column:title] title is a string column
- [entity:Report:column:total] total is a int column, storing the declared default 0 when omitted at insert
- [entity:Report:table] Class Report declares __tablename__ "reports" with the declared column set.


## Forbidden extras
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Entities (the complete data model)
```json
[
  {
    "fields": [
      {
        "column": "id",
        "name": "id",
        "type": "uuid"
      },
      {
        "column": "metric",
        "name": "metric",
        "states": [
          "orders",
          "stock"
        ],
        "type": "enum"
      },
      {
        "column": "ready",
        "default": false,
        "name": "ready",
        "type": "boolean"
      },
      {
        "column": "title",
        "name": "title",
        "type": "string"
      },
      {
        "column": "total",
        "default": 0,
        "name": "total",
        "type": "int"
      }
    ],
    "name": "Report",
    "table": "reports"
  }
]
```

## Engineering notes
- One class per entity; a shared mixin for id/created_at is idiomatic.
- The uuid4 default may be Python-side; it must produce distinct ids per insert.
- No auth in this specification: no password columns.

# Frozen node context
Task: reporting-models
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/reporting/app/models.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "models".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [entity:Report:column:created_at] created_at is a naive-UTC datetime column set once on insert, present on every entity.
- [entity:Report:column:id] id is a uuid column
- [entity:Report:column:metric] metric is a string column validated against {"orders", "stock"}
- [entity:Report:column:ready] ready is a boolean column, storing the declared default false when omitted at insert
- [entity:Report:column:title] title is a string column
- [entity:Report:column:total] total is a int column, storing the declared default 0 when omitted at insert
- [entity:Report:table] Class Report declares __tablename__ "reports" with the declared column set.

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: reporting-models
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: reporting-models
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

### 节点 `warehouse-database` — warehouse: database layer

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/warehouse`；容器内：`/workspace/products/storeplatform/workspace/warehouse`
- 依赖：`warehouse-project`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`e5f28296bb56c98763bf07557576580aeaacdaaac978374e20cb0a54d182d5e6`
- 评审 instruction sha256：`a8ee676f82a464284907411b9a7d2071be495e79b7b975a4ee8368c493db9024`
- spec 节点：`postgres:WarehouseDb`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_database.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: database layer

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/config.py, app/database.py
- Already generated by previous tasks (read-only for you): app/__init__.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [abi:app:config:exports] app/config.py exports only a pydantic-settings Settings class whose optional database_url field reads DATABASE_URL; it reads no dotenv file and instantiates no settings at module import.
- [abi:app:database:exports] app/database.py exports exactly Base, normalize_database_url(value), resolve_database_url(explicit=None), create_engine_from_url(explicit=None), create_session_factory(engine), module defaults engine and SessionLocal, get_db(), and session_dependency(factory).
- [review:app:database:no-extra-apis] (reviewer-judged) app/config.py and app/database.py add no caches, registries, dotenv support, lazy module attributes, or APIs beyond the declared exports.

### function-level clauses
- [database:get-db] get_db yields from the module-default SessionLocal and always closes the session; session_dependency(factory) returns the same yielding dependency bound to the supplied factory.
- [database:sessionmaker] create_session_factory(engine) returns a synchronous sessionmaker with autoflush=False and expire_on_commit=False.
- [database:sqlite-engine] SQLite engines use check_same_thread=False; in-memory SQLite additionally uses StaticPool.
- [database:url-resolution] URL resolution order is pinned: explicit argument → DATABASE_URL env → "sqlite:///./dev.db"; values are ALWAYS SQLAlchemy URLs; a non-empty bare path normalizes to sqlite:///<path>; an empty string uses the fallback.

## Forbidden extras
- The module's public surface is exactly the declared export list — no additional APIs, registries, or framework code.
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Database contract
```json
{
  "engine": "postgres",
  "fallback": "sqlite:///./dev.db",
  "urlEnv": "DATABASE_URL",
  "urlFormat": "sqlalchemy-url"
}
```

## Engineering notes
- Base is the one SQLAlchemy DeclarativeBase imported by models.
- Tables are created via Base.metadata.create_all(engine) at app startup (the app task wires this).

# Frozen node context
Task: warehouse-database
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/warehouse/app/config.py, products/storeplatform/workspace/warehouse/app/database.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "database".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [abi:app:config:exports] app/config.py exports only a pydantic-settings Settings class whose optional database_url field reads DATABASE_URL; it reads no dotenv file and instantiates no settings at module import.
- [abi:app:database:exports] app/database.py exports exactly Base, normalize_database_url(value), resolve_database_url(explicit=None), create_engine_from_url(explicit=None), create_session_factory(engine), module defaults engine and SessionLocal, get_db(), and session_dependency(factory).
- [database:get-db] get_db yields from the module-default SessionLocal and always closes the session; session_dependency(factory) returns the same yielding dependency bound to the supplied factory.
- [database:sessionmaker] create_session_factory(engine) returns a synchronous sessionmaker with autoflush=False and expire_on_commit=False.
- [database:sqlite-engine] SQLite engines use check_same_thread=False; in-memory SQLite additionally uses StaticPool.
- [database:url-resolution] URL resolution order is pinned: explicit argument → DATABASE_URL env → "sqlite:///./dev.db"; values are ALWAYS SQLAlchemy URLs; a non-empty bare path normalizes to sqlite:///<path>; an empty string uses the fallback.

## Reviewer-judged clauses (verify by inspection)
- [review:app:database:no-extra-apis] app/config.py and app/database.py add no caches, registries, dotenv support, lazy module attributes, or APIs beyond the declared exports.

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: warehouse-database
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: warehouse-database
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

### 节点 `warehouse-models` — warehouse: data models

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/warehouse`；容器内：`/workspace/products/storeplatform/workspace/warehouse`
- 依赖：`warehouse-project`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`6d383c65f1c5422385ecaaacbee1ca6f697517ad1db8f28c05f733d3187f2496`
- 评审 instruction sha256：`98e408e9869075d3de146e2cb01813c0d3ab8e18c9a8045655af88dc3854c3e1`
- spec 节点：`entity:Item`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_models.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: data models

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/models.py
- Already generated by previous tasks (read-only for you): app/__init__.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [entity:Item:column:active] active is a boolean column, storing the declared default true when omitted at insert
- [entity:Item:column:created_at] created_at is a naive-UTC datetime column set once on insert, present on every entity.
- [entity:Item:column:id] id is a uuid column
- [entity:Item:column:name] name is a string column
- [entity:Item:column:quantityOnHand] quantityOnHand is a int column, storing the declared default 0 when omitted at insert
- [entity:Item:column:sku] sku is a string column, with a unique constraint
- [entity:Item:table] Class Item declares __tablename__ "items" with the declared column set.


## Forbidden extras
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Entities (the complete data model)
```json
[
  {
    "fields": [
      {
        "column": "active",
        "default": true,
        "name": "active",
        "type": "boolean"
      },
      {
        "column": "id",
        "name": "id",
        "type": "uuid"
      },
      {
        "column": "name",
        "name": "name",
        "type": "string"
      },
      {
        "column": "quantity_on_hand",
        "default": 0,
        "name": "quantityOnHand",
        "type": "int"
      },
      {
        "column": "sku",
        "name": "sku",
        "type": "string",
        "unique": true
      }
    ],
    "name": "Item",
    "table": "items"
  }
]
```

## Engineering notes
- One class per entity; a shared mixin for id/created_at is idiomatic.
- The uuid4 default may be Python-side; it must produce distinct ids per insert.
- No auth in this specification: no password columns.

# Frozen node context
Task: warehouse-models
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/warehouse/app/models.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "models".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [entity:Item:column:active] active is a boolean column, storing the declared default true when omitted at insert
- [entity:Item:column:created_at] created_at is a naive-UTC datetime column set once on insert, present on every entity.
- [entity:Item:column:id] id is a uuid column
- [entity:Item:column:name] name is a string column
- [entity:Item:column:quantityOnHand] quantityOnHand is a int column, storing the declared default 0 when omitted at insert
- [entity:Item:column:sku] sku is a string column, with a unique constraint
- [entity:Item:table] Class Item declares __tablename__ "items" with the declared column set.

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: warehouse-models
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: warehouse-models
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

## 第 3 层 · 3 个 agent 节点（可并行）

### 节点 `orders-schemas` — orders: pydantic schemas

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/orders`；容器内：`/workspace/products/storeplatform/workspace/orders`
- 依赖：`orders-models`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`5fe0a82918f4e927dc00697d2aff5c71aa1d0856d75feb1990dc78d875a11dc2`
- 评审 instruction sha256：`51c9eafaf4413cf8b07725ef6edc4c32ba34048589a9e17f229402e161573975`
- spec 节点：`entity:Order`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_schemas.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: pydantic schemas

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/schemas.py
- Already generated by previous tasks (read-only for you): app/models.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [contract:serialization:create-defaults] Fields with a declared default are omittable in create bodies (the default applies when omitted); optional-without-default stores null.
- [contract:serialization:implicit-columns-hidden] password_hash and created_at are never serialized; created_at only orders lists.
- [contract:serialization:keys] Response keys are the declared field names EXACTLY (camelCase stays camelCase).
- [contract:serialization:refs-as-ids] ref fields serialize as the referenced row's id string.
- [contract:serialization:uuid4-ids] The server generates uuid4 ids; id in request bodies is ignored.
- [schemas:Order:create] The OrderCreate model accepts exactly {id, quantity, reference, status} (defaulted and optional fields omittable).
- [schemas:Order:response] The OrderOut model emits EXACTLY {id, quantity, reference, status} (never password_hash/created_at).
- [schemas:Order:update] The OrderUpdate model makes every accepted field optional — partial PATCH semantics.

### function-level clauses
- [schemas:Order:validation] Field validation follows declared types: string/int/boolean/uuid/email/datetime; ref fields are id strings; enum fields validate against their states.

## Forbidden extras
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Entities
```json
[
  {
    "fields": [
      {
        "column": "id",
        "name": "id",
        "type": "uuid"
      },
      {
        "column": "quantity",
        "default": 1,
        "name": "quantity",
        "type": "int"
      },
      {
        "column": "reference",
        "name": "reference",
        "type": "string",
        "unique": true
      },
      {
        "column": "status",
        "default": "placed",
        "name": "status",
        "states": [
          "placed",
          "fulfilled",
          "cancelled"
        ],
        "type": "enum"
      }
    ],
    "name": "Order"
  }
]
```

## Engineering notes
- Response serialization is contract-critical; the clause table pins the exact key sets.

# Frozen node context
Task: orders-schemas
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/orders/app/schemas.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "schemas".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [contract:serialization:create-defaults] Fields with a declared default are omittable in create bodies (the default applies when omitted); optional-without-default stores null.
- [contract:serialization:implicit-columns-hidden] password_hash and created_at are never serialized; created_at only orders lists.
- [contract:serialization:keys] Response keys are the declared field names EXACTLY (camelCase stays camelCase).
- [contract:serialization:refs-as-ids] ref fields serialize as the referenced row's id string.
- [contract:serialization:uuid4-ids] The server generates uuid4 ids; id in request bodies is ignored.
- [schemas:Order:create] The OrderCreate model accepts exactly {id, quantity, reference, status} (defaulted and optional fields omittable).
- [schemas:Order:response] The OrderOut model emits EXACTLY {id, quantity, reference, status} (never password_hash/created_at).
- [schemas:Order:update] The OrderUpdate model makes every accepted field optional — partial PATCH semantics.
- [schemas:Order:validation] Field validation follows declared types: string/int/boolean/uuid/email/datetime; ref fields are id strings; enum fields validate against their states.

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: orders-schemas
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: orders-schemas
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

### 节点 `reporting-schemas` — reporting: pydantic schemas

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/reporting`；容器内：`/workspace/products/storeplatform/workspace/reporting`
- 依赖：`reporting-models`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`5a9b11a191ca93e8d6326343f125456f4b5925d8780e6abecb8d4c00520e4ba4`
- 评审 instruction sha256：`730ff75e4d2c4c8181cb7207285f98377a7f7100874776dc0519fcc022b9b6d4`
- spec 节点：`entity:Report`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_schemas.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: pydantic schemas

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/schemas.py
- Already generated by previous tasks (read-only for you): app/models.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [contract:serialization:create-defaults] Fields with a declared default are omittable in create bodies (the default applies when omitted); optional-without-default stores null.
- [contract:serialization:implicit-columns-hidden] password_hash and created_at are never serialized; created_at only orders lists.
- [contract:serialization:keys] Response keys are the declared field names EXACTLY (camelCase stays camelCase).
- [contract:serialization:refs-as-ids] ref fields serialize as the referenced row's id string.
- [contract:serialization:uuid4-ids] The server generates uuid4 ids; id in request bodies is ignored.
- [schemas:Report:create] The ReportCreate model accepts exactly {id, metric, ready, title, total} (defaulted and optional fields omittable).
- [schemas:Report:response] The ReportOut model emits EXACTLY {id, metric, ready, title, total} (never password_hash/created_at).
- [schemas:Report:update] The ReportUpdate model makes every accepted field optional — partial PATCH semantics.

### function-level clauses
- [schemas:Report:validation] Field validation follows declared types: string/int/boolean/uuid/email/datetime; ref fields are id strings; enum fields validate against their states.

## Forbidden extras
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Entities
```json
[
  {
    "fields": [
      {
        "column": "id",
        "name": "id",
        "type": "uuid"
      },
      {
        "column": "metric",
        "name": "metric",
        "states": [
          "orders",
          "stock"
        ],
        "type": "enum"
      },
      {
        "column": "ready",
        "default": false,
        "name": "ready",
        "type": "boolean"
      },
      {
        "column": "title",
        "name": "title",
        "type": "string"
      },
      {
        "column": "total",
        "default": 0,
        "name": "total",
        "type": "int"
      }
    ],
    "name": "Report"
  }
]
```

## Engineering notes
- Response serialization is contract-critical; the clause table pins the exact key sets.

# Frozen node context
Task: reporting-schemas
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/reporting/app/schemas.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "schemas".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [contract:serialization:create-defaults] Fields with a declared default are omittable in create bodies (the default applies when omitted); optional-without-default stores null.
- [contract:serialization:implicit-columns-hidden] password_hash and created_at are never serialized; created_at only orders lists.
- [contract:serialization:keys] Response keys are the declared field names EXACTLY (camelCase stays camelCase).
- [contract:serialization:refs-as-ids] ref fields serialize as the referenced row's id string.
- [contract:serialization:uuid4-ids] The server generates uuid4 ids; id in request bodies is ignored.
- [schemas:Report:create] The ReportCreate model accepts exactly {id, metric, ready, title, total} (defaulted and optional fields omittable).
- [schemas:Report:response] The ReportOut model emits EXACTLY {id, metric, ready, title, total} (never password_hash/created_at).
- [schemas:Report:update] The ReportUpdate model makes every accepted field optional — partial PATCH semantics.
- [schemas:Report:validation] Field validation follows declared types: string/int/boolean/uuid/email/datetime; ref fields are id strings; enum fields validate against their states.

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: reporting-schemas
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: reporting-schemas
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

### 节点 `warehouse-schemas` — warehouse: pydantic schemas

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/warehouse`；容器内：`/workspace/products/storeplatform/workspace/warehouse`
- 依赖：`warehouse-models`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`17993d6e8a0964f85cb9c4120068994b24b3cf3f06dfed471e9788d648fec4c8`
- 评审 instruction sha256：`b3b11ba6289e1d2b031309522e455a1341ad2dfe06c43df407eb70d55f86d3c0`
- spec 节点：`entity:Item`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_schemas.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: pydantic schemas

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/schemas.py
- Already generated by previous tasks (read-only for you): app/models.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [contract:serialization:create-defaults] Fields with a declared default are omittable in create bodies (the default applies when omitted); optional-without-default stores null.
- [contract:serialization:implicit-columns-hidden] password_hash and created_at are never serialized; created_at only orders lists.
- [contract:serialization:keys] Response keys are the declared field names EXACTLY (camelCase stays camelCase).
- [contract:serialization:refs-as-ids] ref fields serialize as the referenced row's id string.
- [contract:serialization:uuid4-ids] The server generates uuid4 ids; id in request bodies is ignored.
- [schemas:Item:create] The ItemCreate model accepts exactly {active, id, name, quantityOnHand, sku} (defaulted and optional fields omittable).
- [schemas:Item:response] The ItemOut model emits EXACTLY {active, id, name, quantityOnHand, sku} (never password_hash/created_at).
- [schemas:Item:update] The ItemUpdate model makes every accepted field optional — partial PATCH semantics.

### function-level clauses
- [schemas:Item:validation] Field validation follows declared types: string/int/boolean/uuid/email/datetime; ref fields are id strings; enum fields validate against their states.

## Forbidden extras
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Entities
```json
[
  {
    "fields": [
      {
        "column": "active",
        "default": true,
        "name": "active",
        "type": "boolean"
      },
      {
        "column": "id",
        "name": "id",
        "type": "uuid"
      },
      {
        "column": "name",
        "name": "name",
        "type": "string"
      },
      {
        "column": "quantity_on_hand",
        "default": 0,
        "name": "quantityOnHand",
        "type": "int"
      },
      {
        "column": "sku",
        "name": "sku",
        "type": "string",
        "unique": true
      }
    ],
    "name": "Item"
  }
]
```

## Engineering notes
- Response serialization is contract-critical; the clause table pins the exact key sets.

# Frozen node context
Task: warehouse-schemas
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/warehouse/app/schemas.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "schemas".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [contract:serialization:create-defaults] Fields with a declared default are omittable in create bodies (the default applies when omitted); optional-without-default stores null.
- [contract:serialization:implicit-columns-hidden] password_hash and created_at are never serialized; created_at only orders lists.
- [contract:serialization:keys] Response keys are the declared field names EXACTLY (camelCase stays camelCase).
- [contract:serialization:refs-as-ids] ref fields serialize as the referenced row's id string.
- [contract:serialization:uuid4-ids] The server generates uuid4 ids; id in request bodies is ignored.
- [schemas:Item:create] The ItemCreate model accepts exactly {active, id, name, quantityOnHand, sku} (defaulted and optional fields omittable).
- [schemas:Item:response] The ItemOut model emits EXACTLY {active, id, name, quantityOnHand, sku} (never password_hash/created_at).
- [schemas:Item:update] The ItemUpdate model makes every accepted field optional — partial PATCH semantics.
- [schemas:Item:validation] Field validation follows declared types: string/int/boolean/uuid/email/datetime; ref fields are id strings; enum fields validate against their states.

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: warehouse-schemas
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: warehouse-schemas
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

## 第 4 层 · 3 个 agent 节点（可并行）

### 节点 `orders-router-Order` — orders: router: Order

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/orders`；容器内：`/workspace/products/storeplatform/workspace/orders`
- 依赖：`orders-database`, `orders-models`, `orders-schemas`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`a99533b788424f2b27e7f92d25d1cbfb25866b4efbaa384acc8a514c7f49e7df`
- 评审 instruction sha256：`77d3762c690409584c1f4f9f1eb28211dc45c2d3fdd4344673b8bdb77b5cba73`
- spec 节点：`crud:Order`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_router_order.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: router: Order

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/routers/order.py
- Already generated by previous tasks (read-only for you): app/config.py, app/database.py, app/models.py, app/schemas.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [contract:serialization:create-defaults] Fields with a declared default are omittable in create bodies (the default applies when omitted); optional-without-default stores null.
- [contract:serialization:implicit-columns-hidden] password_hash and created_at are never serialized; created_at only orders lists.
- [contract:serialization:keys] Response keys are the declared field names EXACTLY (camelCase stays camelCase).
- [contract:serialization:refs-as-ids] ref fields serialize as the referenced row's id string.
- [contract:serialization:uuid4-ids] The server generates uuid4 ids; id in request bodies is ignored.
- [import:router:Order:no-orm-base] The router defines no ORM base and imports neither Base nor DeclarativeBase; all mapped classes come from app.models.
- [import:router:Order:sqlalchemy-locations] SQLAlchemy import locations are exact: func, select, and update from sqlalchemy; IntegrityError from sqlalchemy.exc; Session from sqlalchemy.orm; never DeclarativeBase from top-level sqlalchemy.
- [route:GET /api/orders] Route GET /api/orders exists (public, success status 200); list returns 200 with EVERY row as a bare JSON array ordered by created_at ascending.
- [route:GET /api/orders/{id}] Route GET /api/orders/{id} exists (public, success status 200); get returns 200 with the row, or 404 {"detail":"Not found"} for an unknown id.
- [route:POST /api/orders] Route POST /api/orders exists (public, success status 201); create returns 201 with the stored row and maps dangling ref ids to 404 {"detail":"Not found"}.
- [route:POST /api/orders:error:alreadyExists] A unique violation answers 409 {"detail":"Already exists"}.


## Forbidden extras
- No routes exist beyond the clause-listed interface of this task.
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Entity
```json
{
  "fields": [
    {
      "column": "id",
      "name": "id",
      "type": "uuid"
    },
    {
      "column": "quantity",
      "default": 1,
      "name": "quantity",
      "type": "int"
    },
    {
      "column": "reference",
      "name": "reference",
      "type": "string",
      "unique": true
    },
    {
      "column": "status",
      "default": "placed",
      "name": "status",
      "states": [
        "placed",
        "fulfilled",
        "cancelled"
      ],
      "type": "enum"
    }
  ],
  "name": "Order",
  "table": "orders"
}
```

## Engineering notes
- Use the schemas from `app/schemas.py` and the models from `app/models.py`.
- Guards evaluate `requestTime` (the request's receipt time, naive UTC) ONCE per request, bound into the SQL comparison — never baked into code.
- If a reference-validation helper needs a model-class type, use `type[Any]` (with `Any` from `typing`) or omit that annotation.

# Frozen node context
Task: orders-router-Order
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/orders/app/routers/order.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "router:Order".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [contract:serialization:create-defaults] Fields with a declared default are omittable in create bodies (the default applies when omitted); optional-without-default stores null.
- [contract:serialization:implicit-columns-hidden] password_hash and created_at are never serialized; created_at only orders lists.
- [contract:serialization:keys] Response keys are the declared field names EXACTLY (camelCase stays camelCase).
- [contract:serialization:refs-as-ids] ref fields serialize as the referenced row's id string.
- [contract:serialization:uuid4-ids] The server generates uuid4 ids; id in request bodies is ignored.
- [import:router:Order:no-orm-base] The router defines no ORM base and imports neither Base nor DeclarativeBase; all mapped classes come from app.models.
- [import:router:Order:sqlalchemy-locations] SQLAlchemy import locations are exact: func, select, and update from sqlalchemy; IntegrityError from sqlalchemy.exc; Session from sqlalchemy.orm; never DeclarativeBase from top-level sqlalchemy.
- [route:GET /api/orders] Route GET /api/orders exists (public, success status 200); list returns 200 with EVERY row as a bare JSON array ordered by created_at ascending.
- [route:GET /api/orders/{id}] Route GET /api/orders/{id} exists (public, success status 200); get returns 200 with the row, or 404 {"detail":"Not found"} for an unknown id.
- [route:POST /api/orders] Route POST /api/orders exists (public, success status 201); create returns 201 with the stored row and maps dangling ref ids to 404 {"detail":"Not found"}.
- [route:POST /api/orders:error:alreadyExists] A unique violation answers 409 {"detail":"Already exists"}.

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: orders-router-Order
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: orders-router-Order
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

### 节点 `reporting-router-Report` — reporting: router: Report

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/reporting`；容器内：`/workspace/products/storeplatform/workspace/reporting`
- 依赖：`reporting-database`, `reporting-models`, `reporting-schemas`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`a724658d5381fc5fca9b639e87df340573e4966f52a9b6fce1f4ef8f21d6405e`
- 评审 instruction sha256：`15b6be236fe74f624067aa255f1a40dce3df593fabd17e496cdcc026f3235d4a`
- spec 节点：`crud:Report`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_router_report.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: router: Report

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/routers/report.py
- Already generated by previous tasks (read-only for you): app/config.py, app/database.py, app/models.py, app/schemas.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [contract:serialization:create-defaults] Fields with a declared default are omittable in create bodies (the default applies when omitted); optional-without-default stores null.
- [contract:serialization:implicit-columns-hidden] password_hash and created_at are never serialized; created_at only orders lists.
- [contract:serialization:keys] Response keys are the declared field names EXACTLY (camelCase stays camelCase).
- [contract:serialization:refs-as-ids] ref fields serialize as the referenced row's id string.
- [contract:serialization:uuid4-ids] The server generates uuid4 ids; id in request bodies is ignored.
- [import:router:Report:no-orm-base] The router defines no ORM base and imports neither Base nor DeclarativeBase; all mapped classes come from app.models.
- [import:router:Report:sqlalchemy-locations] SQLAlchemy import locations are exact: func, select, and update from sqlalchemy; IntegrityError from sqlalchemy.exc; Session from sqlalchemy.orm; never DeclarativeBase from top-level sqlalchemy.
- [route:GET /api/reports] Route GET /api/reports exists (public, success status 200); list returns 200 with EVERY row as a bare JSON array ordered by created_at ascending.
- [route:GET /api/reports/{id}] Route GET /api/reports/{id} exists (public, success status 200); get returns 200 with the row, or 404 {"detail":"Not found"} for an unknown id.
- [route:POST /api/reports] Route POST /api/reports exists (public, success status 201); create returns 201 with the stored row and maps dangling ref ids to 404 {"detail":"Not found"}.


## Forbidden extras
- No routes exist beyond the clause-listed interface of this task.
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Entity
```json
{
  "fields": [
    {
      "column": "id",
      "name": "id",
      "type": "uuid"
    },
    {
      "column": "metric",
      "name": "metric",
      "states": [
        "orders",
        "stock"
      ],
      "type": "enum"
    },
    {
      "column": "ready",
      "default": false,
      "name": "ready",
      "type": "boolean"
    },
    {
      "column": "title",
      "name": "title",
      "type": "string"
    },
    {
      "column": "total",
      "default": 0,
      "name": "total",
      "type": "int"
    }
  ],
  "name": "Report",
  "table": "reports"
}
```

## Engineering notes
- Use the schemas from `app/schemas.py` and the models from `app/models.py`.
- Guards evaluate `requestTime` (the request's receipt time, naive UTC) ONCE per request, bound into the SQL comparison — never baked into code.
- If a reference-validation helper needs a model-class type, use `type[Any]` (with `Any` from `typing`) or omit that annotation.

# Frozen node context
Task: reporting-router-Report
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/reporting/app/routers/report.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "router:Report".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [contract:serialization:create-defaults] Fields with a declared default are omittable in create bodies (the default applies when omitted); optional-without-default stores null.
- [contract:serialization:implicit-columns-hidden] password_hash and created_at are never serialized; created_at only orders lists.
- [contract:serialization:keys] Response keys are the declared field names EXACTLY (camelCase stays camelCase).
- [contract:serialization:refs-as-ids] ref fields serialize as the referenced row's id string.
- [contract:serialization:uuid4-ids] The server generates uuid4 ids; id in request bodies is ignored.
- [import:router:Report:no-orm-base] The router defines no ORM base and imports neither Base nor DeclarativeBase; all mapped classes come from app.models.
- [import:router:Report:sqlalchemy-locations] SQLAlchemy import locations are exact: func, select, and update from sqlalchemy; IntegrityError from sqlalchemy.exc; Session from sqlalchemy.orm; never DeclarativeBase from top-level sqlalchemy.
- [route:GET /api/reports] Route GET /api/reports exists (public, success status 200); list returns 200 with EVERY row as a bare JSON array ordered by created_at ascending.
- [route:GET /api/reports/{id}] Route GET /api/reports/{id} exists (public, success status 200); get returns 200 with the row, or 404 {"detail":"Not found"} for an unknown id.
- [route:POST /api/reports] Route POST /api/reports exists (public, success status 201); create returns 201 with the stored row and maps dangling ref ids to 404 {"detail":"Not found"}.

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: reporting-router-Report
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: reporting-router-Report
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

### 节点 `warehouse-router-Item` — warehouse: router: Item

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/warehouse`；容器内：`/workspace/products/storeplatform/workspace/warehouse`
- 依赖：`warehouse-database`, `warehouse-models`, `warehouse-schemas`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`261b25b25edb04c3ccd6ed99086ce74b27085d9e93f2c7013e37245f6a78dd69`
- 评审 instruction sha256：`acac46efe58417cce755b7ee54bf68ae3e4bfca2ac0accd483c0c6d1bc2f4308`
- spec 节点：`crud:Item`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_router_item.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: router: Item

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/routers/item.py
- Already generated by previous tasks (read-only for you): app/config.py, app/database.py, app/models.py, app/schemas.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [contract:serialization:create-defaults] Fields with a declared default are omittable in create bodies (the default applies when omitted); optional-without-default stores null.
- [contract:serialization:implicit-columns-hidden] password_hash and created_at are never serialized; created_at only orders lists.
- [contract:serialization:keys] Response keys are the declared field names EXACTLY (camelCase stays camelCase).
- [contract:serialization:refs-as-ids] ref fields serialize as the referenced row's id string.
- [contract:serialization:uuid4-ids] The server generates uuid4 ids; id in request bodies is ignored.
- [import:router:Item:no-orm-base] The router defines no ORM base and imports neither Base nor DeclarativeBase; all mapped classes come from app.models.
- [import:router:Item:sqlalchemy-locations] SQLAlchemy import locations are exact: func, select, and update from sqlalchemy; IntegrityError from sqlalchemy.exc; Session from sqlalchemy.orm; never DeclarativeBase from top-level sqlalchemy.
- [route:DELETE /api/items/{id}] Route DELETE /api/items/{id} exists (public, success status 204); delete returns 204 with an empty body, or 404 {"detail":"Not found"} for an unknown id.
- [route:GET /api/items] Route GET /api/items exists (public, success status 200); list returns 200 with EVERY row as a bare JSON array ordered by created_at ascending.
- [route:GET /api/items/{id}] Route GET /api/items/{id} exists (public, success status 200); get returns 200 with the row, or 404 {"detail":"Not found"} for an unknown id.
- [route:PATCH /api/items/{id}] Route PATCH /api/items/{id} exists (public, success status 200); update is a partial PATCH returning 200 with the full row, or 404 {"detail":"Not found"} for an unknown id.
- [route:PATCH /api/items/{id}:error:alreadyExists] A unique violation answers 409 {"detail":"Already exists"}.
- [route:POST /api/items] Route POST /api/items exists (public, success status 201); create returns 201 with the stored row and maps dangling ref ids to 404 {"detail":"Not found"}.
- [route:POST /api/items:error:alreadyExists] A unique violation answers 409 {"detail":"Already exists"}.


## Forbidden extras
- No routes exist beyond the clause-listed interface of this task.
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Entity
```json
{
  "fields": [
    {
      "column": "active",
      "default": true,
      "name": "active",
      "type": "boolean"
    },
    {
      "column": "id",
      "name": "id",
      "type": "uuid"
    },
    {
      "column": "name",
      "name": "name",
      "type": "string"
    },
    {
      "column": "quantity_on_hand",
      "default": 0,
      "name": "quantityOnHand",
      "type": "int"
    },
    {
      "column": "sku",
      "name": "sku",
      "type": "string",
      "unique": true
    }
  ],
  "name": "Item",
  "table": "items"
}
```

## Engineering notes
- Use the schemas from `app/schemas.py` and the models from `app/models.py`.
- Guards evaluate `requestTime` (the request's receipt time, naive UTC) ONCE per request, bound into the SQL comparison — never baked into code.
- If a reference-validation helper needs a model-class type, use `type[Any]` (with `Any` from `typing`) or omit that annotation.

# Frozen node context
Task: warehouse-router-Item
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/warehouse/app/routers/item.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "router:Item".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [contract:serialization:create-defaults] Fields with a declared default are omittable in create bodies (the default applies when omitted); optional-without-default stores null.
- [contract:serialization:implicit-columns-hidden] password_hash and created_at are never serialized; created_at only orders lists.
- [contract:serialization:keys] Response keys are the declared field names EXACTLY (camelCase stays camelCase).
- [contract:serialization:refs-as-ids] ref fields serialize as the referenced row's id string.
- [contract:serialization:uuid4-ids] The server generates uuid4 ids; id in request bodies is ignored.
- [import:router:Item:no-orm-base] The router defines no ORM base and imports neither Base nor DeclarativeBase; all mapped classes come from app.models.
- [import:router:Item:sqlalchemy-locations] SQLAlchemy import locations are exact: func, select, and update from sqlalchemy; IntegrityError from sqlalchemy.exc; Session from sqlalchemy.orm; never DeclarativeBase from top-level sqlalchemy.
- [route:DELETE /api/items/{id}] Route DELETE /api/items/{id} exists (public, success status 204); delete returns 204 with an empty body, or 404 {"detail":"Not found"} for an unknown id.
- [route:GET /api/items] Route GET /api/items exists (public, success status 200); list returns 200 with EVERY row as a bare JSON array ordered by created_at ascending.
- [route:GET /api/items/{id}] Route GET /api/items/{id} exists (public, success status 200); get returns 200 with the row, or 404 {"detail":"Not found"} for an unknown id.
- [route:PATCH /api/items/{id}] Route PATCH /api/items/{id} exists (public, success status 200); update is a partial PATCH returning 200 with the full row, or 404 {"detail":"Not found"} for an unknown id.
- [route:PATCH /api/items/{id}:error:alreadyExists] A unique violation answers 409 {"detail":"Already exists"}.
- [route:POST /api/items] Route POST /api/items exists (public, success status 201); create returns 201 with the stored row and maps dangling ref ids to 404 {"detail":"Not found"}.
- [route:POST /api/items:error:alreadyExists] A unique violation answers 409 {"detail":"Already exists"}.

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: warehouse-router-Item
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: warehouse-router-Item
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

## 第 5 层 · 3 个 agent 节点（可并行）

### 节点 `orders-app` — orders: application wiring

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/orders`；容器内：`/workspace/products/storeplatform/workspace/orders`
- 依赖：`orders-database`, `orders-router-Order`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`a34c00bfcb493e1c0764b4196cb25103a78935ac6ae76e3a897a0474aa36eba4`
- 评审 instruction sha256：`9a9744974b6a475c84e840f8d4b08401739ecaedee67103ff0c65281b79b48c5`
- spec 节点：`app:StorePlatform`, `fastapi:OrdersServer`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_app.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: application wiring

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/main.py
- Already generated by previous tasks (read-only for you): app/config.py, app/database.py, app/routers/order.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [abi:app:main:exports] app/main.py exports create_app(database_url: str | None = None) -> FastAPI AND a module-level app = create_app().
- [app:router-registry] ROUTERS is imported from the compiler-owned app.router_registry and each entry is included exactly once in tuple order; routers are imported/registered by no other path.
- [app:routes-complete] The application exposes EXACTLY the declared route interface {GET /api/orders; GET /api/orders/{id}; POST /api/orders} — strict OpenAPI equality (FastAPI's automatic /openapi.json and /docs are fine).
- [app:title-version] The application title is "Orders API" and the version "0.1.0".

### function-level clauses
- [app:engine-isolation] Each create_app call creates one engine via create_engine_from_url(database_url) and one session factory, stores them on app.state, overrides get_db with session_dependency(factory), creates tables on startup against that engine, and disposes it on shutdown — this is what makes separate create_app(database_url=...) calls isolated.
- [app:state-adapters] Deterministic in-memory cache, messaging, and blob adapters are constructed by default and exposed as app.state.cache, app.state.messaging, and app.state.blob when their corresponding contracts exist.

## Forbidden extras
- The module's public surface is exactly the declared export list — no additional APIs, registries, or framework code.
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Application
```json
{
  "name": "StorePlatform",
  "port": 8000,
  "prefix": "/api",
  "title": "Orders API",
  "version": "0.1.0"
}
```

## Engineering notes
- Count routes must be reachable after inclusion (registration order comes from the compiler-owned registry tuple).

# Frozen node context
Task: orders-app
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/orders/app/main.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "app".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [abi:app:main:exports] app/main.py exports create_app(database_url: str | None = None) -> FastAPI AND a module-level app = create_app().
- [app:engine-isolation] Each create_app call creates one engine via create_engine_from_url(database_url) and one session factory, stores them on app.state, overrides get_db with session_dependency(factory), creates tables on startup against that engine, and disposes it on shutdown — this is what makes separate create_app(database_url=...) calls isolated.
- [app:router-registry] ROUTERS is imported from the compiler-owned app.router_registry and each entry is included exactly once in tuple order; routers are imported/registered by no other path.
- [app:routes-complete] The application exposes EXACTLY the declared route interface {GET /api/orders; GET /api/orders/{id}; POST /api/orders} — strict OpenAPI equality (FastAPI's automatic /openapi.json and /docs are fine).
- [app:state-adapters] Deterministic in-memory cache, messaging, and blob adapters are constructed by default and exposed as app.state.cache, app.state.messaging, and app.state.blob when their corresponding contracts exist.
- [app:title-version] The application title is "Orders API" and the version "0.1.0".

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: orders-app
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: orders-app
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

### 节点 `reporting-app` — reporting: application wiring

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/reporting`；容器内：`/workspace/products/storeplatform/workspace/reporting`
- 依赖：`reporting-database`, `reporting-router-Report`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`28bd22cdaa315d6283c6b8d96d763320af838fc699092fa8ce0f0c9fbe76aa04`
- 评审 instruction sha256：`bcc629db65d33137bfba143fcb8ee7cd9c5ab66f0da442ee2d16a14977d55373`
- spec 节点：`app:StorePlatform`, `fastapi:ReportingServer`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_app.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: application wiring

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/main.py
- Already generated by previous tasks (read-only for you): app/config.py, app/database.py, app/routers/report.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [abi:app:main:exports] app/main.py exports create_app(database_url: str | None = None) -> FastAPI AND a module-level app = create_app().
- [app:router-registry] ROUTERS is imported from the compiler-owned app.router_registry and each entry is included exactly once in tuple order; routers are imported/registered by no other path.
- [app:routes-complete] The application exposes EXACTLY the declared route interface {GET /api/reports; GET /api/reports/{id}; POST /api/reports} — strict OpenAPI equality (FastAPI's automatic /openapi.json and /docs are fine).
- [app:title-version] The application title is "Reporting API" and the version "0.1.0".

### function-level clauses
- [app:engine-isolation] Each create_app call creates one engine via create_engine_from_url(database_url) and one session factory, stores them on app.state, overrides get_db with session_dependency(factory), creates tables on startup against that engine, and disposes it on shutdown — this is what makes separate create_app(database_url=...) calls isolated.
- [app:state-adapters] Deterministic in-memory cache, messaging, and blob adapters are constructed by default and exposed as app.state.cache, app.state.messaging, and app.state.blob when their corresponding contracts exist.

## Forbidden extras
- The module's public surface is exactly the declared export list — no additional APIs, registries, or framework code.
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Application
```json
{
  "name": "StorePlatform",
  "port": 8000,
  "prefix": "/api",
  "title": "Reporting API",
  "version": "0.1.0"
}
```

## Engineering notes
- Count routes must be reachable after inclusion (registration order comes from the compiler-owned registry tuple).

# Frozen node context
Task: reporting-app
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/reporting/app/main.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "app".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [abi:app:main:exports] app/main.py exports create_app(database_url: str | None = None) -> FastAPI AND a module-level app = create_app().
- [app:engine-isolation] Each create_app call creates one engine via create_engine_from_url(database_url) and one session factory, stores them on app.state, overrides get_db with session_dependency(factory), creates tables on startup against that engine, and disposes it on shutdown — this is what makes separate create_app(database_url=...) calls isolated.
- [app:router-registry] ROUTERS is imported from the compiler-owned app.router_registry and each entry is included exactly once in tuple order; routers are imported/registered by no other path.
- [app:routes-complete] The application exposes EXACTLY the declared route interface {GET /api/reports; GET /api/reports/{id}; POST /api/reports} — strict OpenAPI equality (FastAPI's automatic /openapi.json and /docs are fine).
- [app:state-adapters] Deterministic in-memory cache, messaging, and blob adapters are constructed by default and exposed as app.state.cache, app.state.messaging, and app.state.blob when their corresponding contracts exist.
- [app:title-version] The application title is "Reporting API" and the version "0.1.0".

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: reporting-app
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: reporting-app
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

### 节点 `warehouse-app` — warehouse: application wiring

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace/warehouse`；容器内：`/workspace/products/storeplatform/workspace/warehouse`
- 依赖：`warehouse-database`, `warehouse-router-Item`
- 轮次上限：3（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）
- 实现 instruction sha256：`5226a86036303646a8a25dd066165cd86c813e46592c452f0ce8d8ad6e9cc481`
- 评审 instruction sha256：`58ccd472de2926e6598a51ada4e7850f71eb4ef49f67d34214bfd716f96a78fd`
- spec 节点：`app:StorePlatform`, `fastapi:WarehouseServer`
- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：

````bash
uv run --no-project --python '3.13' --with 'bcrypt==5.0.0' --with 'email-validator==2.2.0' --with 'fastapi==0.141.1' --with 'httpx==0.28.1' --with 'pydantic==2.13.5' --with 'pydantic-settings==2.15.0' --with 'pyjwt==2.13.0' --with 'pytest==9.1.1' --with 'sqlalchemy==2.0.52' --with 'uvicorn==0.52.4' python -B -m pytest -p no:cacheprovider -q tests/spec_oracle/test_app.py
````


#### 实现 agent · 第 1 轮完整 stdin（逐字）

````text
You are executing ONE TASK of a larger, compiler-planned generation.

# Task: application wiring

The specification compiler derived this task from the user's
specification. Files from previous tasks already exist in this workspace
and are part of the same application: READ them for context, match their
conventions, and do NOT modify anything outside your scope.

- Your scope (create/modify ONLY these): app/main.py
- Already generated by previous tasks (read-only for you): app/config.py, app/database.py, app/routers/item.py
- Put every scratch file, downloaded package, temporary virtualenv, and tool
  cache outside the repository (use `/tmp`). Never create `.pkg-tmp`, a
  temporary dependency directory, or any other unowned path in the workspace.
- The available shell is intentionally narrow. Do not invoke `pip`, `venv`,
  `git`, shell redirection, pipes, `cd`, or chained shell commands. If a
  focused runtime probe is truly necessary, use one command beginning with
  `uv run --no-project --with <pinned-package> ...`; otherwise reason from
  the pinned contract and write only the owned files.

## Node contract (clause table)

These clauses are the COMPLETE behavioral contract for this task. Each is
machine-verified (oracle) or reviewer-judged (review) exactly as written;
anything not stated here is implementation freedom.

### api-level clauses
- [abi:app:main:exports] app/main.py exports create_app(database_url: str | None = None) -> FastAPI AND a module-level app = create_app().
- [app:router-registry] ROUTERS is imported from the compiler-owned app.router_registry and each entry is included exactly once in tuple order; routers are imported/registered by no other path.
- [app:routes-complete] The application exposes EXACTLY the declared route interface {GET /api/items; GET /api/items/{id}; POST /api/items; PATCH /api/items/{id}; DELETE /api/items/{id}} — strict OpenAPI equality (FastAPI's automatic /openapi.json and /docs are fine).
- [app:title-version] The application title is "Warehouse API" and the version "0.1.0".

### function-level clauses
- [app:engine-isolation] Each create_app call creates one engine via create_engine_from_url(database_url) and one session factory, stores them on app.state, overrides get_db with session_dependency(factory), creates tables on startup against that engine, and disposes it on shutdown — this is what makes separate create_app(database_url=...) calls isolated.
- [app:state-adapters] Deterministic in-memory cache, messaging, and blob adapters are constructed by default and exposed as app.state.cache, app.state.messaging, and app.state.blob when their corresponding contracts exist.

## Forbidden extras
- The module's public surface is exactly the declared export list — no additional APIs, registries, or framework code.
- Files beyond your scope are never created or modified.

## Shared operational constraints
- Path parameters are named exactly `id`.
- Error bodies are exact JSON, never wrapped, renamed, or extended: 401 {"detail":"Not authenticated"} · 404 {"detail":"Not found"} · 409 bodies as pinned per clause · 422 = the FastAPI default.
- SQLite-compatible SQL only (tests run on SQLite).
- Do not add any route, file, or path beyond your scope — the conformance suite asserts STRICT OpenAPI equality.

## Contract challenge protocol
If you conclude this contract is internally unsatisfiable or wrong, make no
edits and reply with exactly one JSON object and nothing else:
{"challenge":{"clause":"<clause id>","reason":"<one paragraph>"}}
Never improvise around a defect; challenging it is the only correct response.

## Target and package engineering guidance

### @spec/fastapi · python-fastapi-baseline
- Use Python 3.13 type hints on public functions and concrete return types; avoid Any except at serialization boundaries.
- Keep asynchronous I/O non-blocking and move unavoidable blocking SDK calls to asyncio.to_thread.
- Create network clients and pools in FastAPI lifespan, inject them into services, and close them in reverse order.
- Use typed settings for configuration, explicit timeouts, bounded retries, and structured logging without secrets or payload bodies.
- Keep provider adapters behind small protocols and make every behavior independently testable with deterministic in-memory adapters.
- Do not catch broad exceptions unless translating them into a contract-defined typed error while preserving the original cause.

This guidance is subordinate to the node contract in the clause table.
If guidance appears to conflict with a clause, implement the clause.

## Reference data (subordinate to the clause table)
### Application
```json
{
  "name": "StorePlatform",
  "port": 8000,
  "prefix": "/api",
  "title": "Warehouse API",
  "version": "0.1.0"
}
```

## Engineering notes
- Count routes must be reachable after inclusion (registration order comes from the compiler-owned registry tuple).

# Frozen node context
Task: warehouse-app
Round: 1/3
This is the first round.

You own only: products/storeplatform/workspace/warehouse/app/main.py.
````

#### 评审 agent · 第 1 轮 stdin 模板（`<TEST_EVIDENCE>` 为运行时数据）

````text
You are the read-only reviewer for generation node "app".
Verify the implementation against the frozen node contract below. The
oracle clauses are already machine-verified by the compiler-owned tests in
the evidence — confirm the implementation does not merely game those
tests (hardcoded outputs, condition-special-casing, dead code paths).
The reviewer-judged clauses MUST be verified by code inspection.

## Oracle clauses (machine-verified — check for gaming, not re-derivation)
- [abi:app:main:exports] app/main.py exports create_app(database_url: str | None = None) -> FastAPI AND a module-level app = create_app().
- [app:engine-isolation] Each create_app call creates one engine via create_engine_from_url(database_url) and one session factory, stores them on app.state, overrides get_db with session_dependency(factory), creates tables on startup against that engine, and disposes it on shutdown — this is what makes separate create_app(database_url=...) calls isolated.
- [app:router-registry] ROUTERS is imported from the compiler-owned app.router_registry and each entry is included exactly once in tuple order; routers are imported/registered by no other path.
- [app:routes-complete] The application exposes EXACTLY the declared route interface {GET /api/items; GET /api/items/{id}; POST /api/items; PATCH /api/items/{id}; DELETE /api/items/{id}} — strict OpenAPI equality (FastAPI's automatic /openapi.json and /docs are fine).
- [app:state-adapters] Deterministic in-memory cache, messaging, and blob adapters are constructed by default and exposed as app.state.cache, app.state.messaging, and app.state.blob when their corresponding contracts exist.
- [app:title-version] The application title is "Warehouse API" and the version "0.1.0".

## Reviewer-judged clauses (verify by inspection)
- (none)

Look for missing behavior, extra public API or routes, ABI drift, invalid
imports, and uncovered constraints. Do not edit any file. Your result must
be exactly one JSON object and nothing else: {"approved":boolean,"feedback":"specific changes keyed to clause ids"}.

# Frozen node context
Task: warehouse-app
Round: 1/3
This is the first round.

Review the implementation against the frozen node contract and its clause table. The machine evidence is:
<<TEST_EVIDENCE>>
Do not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {"approved":boolean,"feedback":"specific changes keyed to clause ids where applicable"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.
````

#### 第 2–3 轮 · 上下文块（其余逐字节不变）

````text


# Frozen node context
Task: warehouse-app
Round: <轮次>/3
Reviewer feedback from the prior round:
<上一轮评审 verdict 的 feedback 字段逐字内容>

````

将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。

## 第 6 层 · materialize（非 agent）

### 节点 `conformance` — materialize and run the compiler-owned conformance oracle

#### 元信息

- 任务目录（仓库相对）：`products/storeplatform/workspace`；容器内：`/workspace/products/storeplatform/workspace`
- 依赖：`orders-app`, `reporting-app`, `warehouse-app`
- instruction："Materialize the oracle exactly and verify once. Never repair generated code after conformance."
- 物化文件（19 个，内容见 plan.json 的 `materializedFiles`，逐字写入任务目录）：

````
.spec-interfaces/test_contracts.py
orders/conformance/behavior_snapshot.py
orders/conformance/conftest.py
orders/conformance/contract.json
orders/conformance/helpers.py
orders/conformance/test_contract.py
orders/conformance/test_infrastructure.py
reporting/conformance/behavior_snapshot.py
reporting/conformance/conftest.py
reporting/conformance/contract.json
reporting/conformance/helpers.py
reporting/conformance/test_contract.py
reporting/conformance/test_infrastructure.py
warehouse/conformance/behavior_snapshot.py
warehouse/conformance/conftest.py
warehouse/conformance/contract.json
warehouse/conformance/helpers.py
warehouse/conformance/test_contract.py
warehouse/conformance/test_infrastructure.py
````

- 验收命令：

````bash
cd 'orders' && uv venv .venv --clear --quiet --python 3.13
cd 'orders' && uv pip install --quiet -e '.[dev]'
cd 'reporting' && uv venv .venv --clear --quiet --python 3.13
cd 'reporting' && uv pip install --quiet -e '.[dev]'
cd 'warehouse' && uv venv .venv --clear --quiet --python 3.13
cd 'warehouse' && uv pip install --quiet -e '.[dev]'
cd 'orders' && .venv/bin/python -c "from app.main import app, create_app; assert app.title"
cd 'orders' && .venv/bin/python -m pytest conformance -q
cd 'reporting' && .venv/bin/python -c "from app.main import app, create_app; assert app.title"
cd 'reporting' && .venv/bin/python -m pytest conformance -q
cd 'warehouse' && .venv/bin/python -c "from app.main import app, create_app; assert app.title"
cd 'warehouse' && .venv/bin/python -m pytest conformance -q
mkdir -p conformance-output && reporting/.venv/bin/python .spec-interfaces/test_contracts.py > conformance-output/interfaces.json
cd 'orders' && mkdir -p conformance-output && .venv/bin/python -W ignore -c 'import json
from app.main import app
spec = app.openapi()
norm = {}
for path, ops in spec.get("paths", {}).items():
    for method, op in ops.items():
        if method not in ("get", "post", "put", "patch", "delete"):
            continue
        norm[f"{method.upper()} {path}"] = {
            "statuses": sorted(op.get("responses", {}).keys()),
            "pathParams": sorted(p["name"] for p in op.get("parameters", []) if p.get("in") == "path"),
            "requestBody": bool(op.get("requestBody", {}).get("required", False)),
        }
print(json.dumps(norm, sort_keys=True, indent=2))
' > conformance-output/openapi.json
cd 'orders' && .venv/bin/python -W ignore conformance/behavior_snapshot.py > conformance-output/behavior.json
cd 'reporting' && mkdir -p conformance-output && .venv/bin/python -W ignore -c 'import json
from app.main import app
spec = app.openapi()
norm = {}
for path, ops in spec.get("paths", {}).items():
    for method, op in ops.items():
        if method not in ("get", "post", "put", "patch", "delete"):
            continue
        norm[f"{method.upper()} {path}"] = {
            "statuses": sorted(op.get("responses", {}).keys()),
            "pathParams": sorted(p["name"] for p in op.get("parameters", []) if p.get("in") == "path"),
            "requestBody": bool(op.get("requestBody", {}).get("required", False)),
        }
print(json.dumps(norm, sort_keys=True, indent=2))
' > conformance-output/openapi.json
cd 'reporting' && .venv/bin/python -W ignore conformance/behavior_snapshot.py > conformance-output/behavior.json
cd 'warehouse' && mkdir -p conformance-output && .venv/bin/python -W ignore -c 'import json
from app.main import app
spec = app.openapi()
norm = {}
for path, ops in spec.get("paths", {}).items():
    for method, op in ops.items():
        if method not in ("get", "post", "put", "patch", "delete"):
            continue
        norm[f"{method.upper()} {path}"] = {
            "statuses": sorted(op.get("responses", {}).keys()),
            "pathParams": sorted(p["name"] for p in op.get("parameters", []) if p.get("in") == "path"),
            "requestBody": bool(op.get("requestBody", {}).get("required", False)),
        }
print(json.dumps(norm, sort_keys=True, indent=2))
' > conformance-output/openapi.json
cd 'warehouse' && .venv/bin/python -W ignore conformance/behavior_snapshot.py > conformance-output/behavior.json
````


## 逐字完整性

本文件由 `scripts/export-agent-prompts.mjs` 写出后立即回读校验：18 个 agent 节点的实现/测试第 1 轮完整 stdin 与评审模板头尾必须逐字节命中，否则生成失败。每个角色的 instruction sha256 见各节点元信息，可独立复算。
