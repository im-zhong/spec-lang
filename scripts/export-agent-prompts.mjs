#!/usr/bin/env node
// Deterministically export every runtime agent prompt of an archived
// generation plan (plan.json) into a structured replay handbook.
//
// The prompt assembly mirrors packages/execution/src/docker.ts byte for
// byte (loop prompts at docker.ts:296-357, commands at docker.ts:31-47,
// safeName at docker.ts:131-133, runner arg order at
// packages/agent/src/runner.ts:68-85). If those change, update the
// formulas here together with the provenance notes they cite.
//
// Usage:
//   node scripts/export-agent-prompts.mjs <plan.json> <out.md> \
//     [--title "..."] [--composite .spec/composite.agent.tasks.json]
//
// The output contains no timestamps and no environment-dependent values,
// so regenerating from the same plan.json is byte-stable. The script
// re-reads what it wrote and fails loudly unless every verbatim prompt
// round-trips exactly.

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const FENCE = "````"

// Verbatim from packages/execution/src/docker.ts:31-39 (DEFAULT_AGENT_COMMAND).
const WRITER_ALLOWED_TOOLS = [
  "Read", "Glob", "Grep", "LS", "Edit", "Write",
  "Bash(uv:*)", "Bash(python:*)", "Bash(python3:*)", "Bash(.venv/bin/python:*)",
  "Bash(pytest:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)",
  "Bash(wc:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(mkdir:*)", "Bash(sed:*)",
]

// Verbatim from packages/execution/src/docker.ts:41-47 (DEFAULT_REVIEWER_COMMAND).
const REVIEWER_ALLOWED_TOOLS = [
  "Read", "Glob", "Grep", "LS", "Bash(uv:*)", "Bash(python:*)", "Bash(python3:*)",
  "Bash(.venv/bin/python:*)", "Bash(pytest:*)", "Bash(ls:*)", "Bash(cat:*)",
  "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(sed:*)",
]

// docker.ts (loop v0.2) — reviewer suffix uses real newlines, not "\n" literals.
const REVIEWER_SUFFIX_HEAD = "\nReview the implementation against the frozen node contract and its clause table. The machine evidence is:\n"
const REVIEWER_SUFFIX_TAIL = "\nDo not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {\"approved\":boolean,\"feedback\":\"specific changes keyed to clause ids where applicable\"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection."

// docker.ts:131-133
function safeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120)
}

// github-generation.ts:61-64 — composite task id -> GitHub plan task id.
function safeTaskId(id) {
  return id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

// docker.ts:297-298
function sharedBlock(task, round, feedback) {
  const head = `\n\n# Frozen node context\nTask: ${task.id}\nRound: ${round}/${task.loop.maxRounds}\n`
  return feedback === undefined
    ? `${head}This is the first round.\n`
    : `${head}Reviewer feedback from the prior round:\n${feedback}\n`
}

// docker.ts (loop v0.2): the single implementation writer.
function writerPrompt(task, round, feedback) {
  const shared = sharedBlock(task, round, feedback)
  return `${task.loop.implementation.instruction}${shared}\nYou own only: ${task.loop.implementation.scope.join(", ")}.`
}

// docker.ts:354-357 — evidence is runtime data; caller substitutes the placeholder.
function reviewerPromptParts(task, round) {
  return {
    head: `${task.loop.reviewer.instruction}${sharedBlock(task, round, undefined)}${REVIEWER_SUFFIX_HEAD}`,
    tail: REVIEWER_SUFFIX_TAIL,
  }
}

function fail(message) {
  console.error(`export-agent-prompts: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const positional = []
  const options = { title: undefined, composite: undefined }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === "--title") options.title = argv[++index]
    else if (value === "--composite") options.composite = argv[++index]
    else if (value.startsWith("--")) fail(`unknown option ${value}`)
    else positional.push(value)
  }
  if (positional.length !== 2) {
    console.error("usage: node scripts/export-agent-prompts.mjs <plan.json> <out.md> [--title ...] [--composite ...]")
    process.exit(2)
  }
  return { planPath: positional[0], outPath: positional[1], ...options }
}

function loadPlan(planPath) {
  const plan = JSON.parse(readFileSync(planPath, "utf8"))
  if (!Array.isArray(plan.tasks)) fail(`${planPath} has no tasks array`)
  const byId = new Map(plan.tasks.map((task) => [task.id, task]))
  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!byId.has(dependency)) fail(`task ${task.id} depends on unknown task ${dependency}`)
    }
    if (task.executor === "agent" && !task.loop) fail(`agent task ${task.id} has no loop`)
    if (task.executor === "agent") {
      for (const role of ["implementation", "reviewer"]) {
        const part = task.loop[role]
        if (!part?.instruction) fail(`task ${task.id} loop.${role}.instruction missing`)
        if (role !== "reviewer" && !Array.isArray(part.scope)) fail(`task ${task.id} loop.${role}.scope missing`)
      }
      if (!Array.isArray(task.loop.reviewer.commands)) fail(`task ${task.id} loop.reviewer.commands missing`)
    }
  }
  return { plan, byId }
}

// Longest-path layering over dependsOn; cycle-safe via explicit visit stack.
function computeWaves(tasks, byId) {
  const layerOf = new Map()
  const visiting = new Set()
  const layer = (task) => {
    const cached = layerOf.get(task.id)
    if (cached !== undefined) return cached
    if (visiting.has(task.id)) fail(`dependency cycle through task ${task.id}`)
    visiting.add(task.id)
    let depth = 0
    for (const dependency of task.dependsOn ?? []) {
      depth = Math.max(depth, layer(byId.get(dependency)) + 1)
    }
    visiting.delete(task.id)
    layerOf.set(task.id, depth)
    return depth
  }
  for (const task of tasks) layer(task)
  const waves = new Map()
  for (const task of tasks) {
    const depth = layerOf.get(task.id)
    if (!waves.has(depth)) waves.set(depth, [])
    waves.get(depth).push(task)
  }
  return [...waves.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([depth, waveTasks]) => ({
      depth,
      tasks: [...waveTasks].sort((left, right) => left.id.localeCompare(right.id)),
    }))
}

function claudeCommand(permissionMode, allowedTools, agent) {
  const args = [
    "-p", "--output-format", "json", "--safe-mode", "--no-session-persistence",
    "--permission-mode", permissionMode,
    "--model", agent.model, "--effort", agent.effort, "--max-turns", String(agent.maxTurns),
    "--allowedTools", ...allowedTools,
  ]
  return `claude ${args.join(" ")}`
}

function fence(content, language = "text") {
  if (content.includes(FENCE)) fail("prompt content contains a 4-backtick run; fence depth insufficient")
  return `${FENCE}${language}\n${content}\n${FENCE}`
}

function relativeTo(workingDirectory, file) {
  const prefix = `${workingDirectory}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}

function buildDocument({ plan, byId, planPath, title, agent, waves }) {
  const lines = []
  const emit = (...rows) => lines.push(...rows)
  const agentWaves = waves.filter((wave) => wave.tasks.some((task) => task.executor === "agent"))
  const materializeTasks = new Map()
  for (const wave of waves) {
    for (const task of wave.tasks) {
      if (task.executor !== "agent") materializeTasks.set(task.id, wave.depth)
    }
  }

  emit(`# ${title}`, "")
  emit("本手册由脚本从归档执行计划确定性导出（无时间戳、无环境相关值），",
    "包含回放该 run 所需的**全部运行时 prompt**。", "")
  emit("## 来源与拼装规则", "")
  emit(`- 执行计划：\`${planPath}\`（run \`${plan.runId}\`，仓库 \`${plan.repository}\`，fingerprint \`${plan.fingerprint}\`）`)
  emit(`- 执行环境：镜像 \`${plan.environment.image}\`；模型 \`${agent.model}\`，effort \`${agent.effort}\`，turn 上限 \`${agent.maxTurns}\`，并发上限 \`${agent.maxConcurrency}\``)
  emit("- Prompt 拼装公式与 \`packages/execution/src/docker.ts:296-357\` 逐字节一致：")
  emit("  - 上下文块 = 角色指令 + \`# Frozen node context\` 块 + 所有权行（见下文公式）")
  emit("  - 第 2 轮起，仅上下文块中的轮次号与 \`Reviewer feedback from the prior round:\` 段变化，其余逐字节不变")
  emit("- 重新生成本文件：\`node scripts/export-agent-prompts.mjs <plan.json> <out.md>\`；脚本写完后会回读校验每个逐字 prompt", "")
  emit("## 回放方法", "")
  emit("循环 v0.2：每轮**单个实现 agent 直接在任务目录执行**（无快照目录），随后只读评审在任务目录执行。prompt 一律经 **stdin** 传入（\`claude … < prompt.txt\`）。编译器物化的节点 oracle（\`tests/spec_oracle/\`）随 compiler-seed 落盘，任何 agent 不可编辑；评审与验收命令运行它。若实现 agent 认为契约有缺陷，输出 \\`{\"challenge\":{...}}\\` 即终止 run（spec 缺陷，golden-rule 响应）。", "")
  emit("writer（实现 agent）：", "")
  emit(fence(claudeCommand("acceptEdits", WRITER_ALLOWED_TOOLS, agent), "bash"), "")
  emit("评审（只读，permission-mode plan）：", "")
  emit(fence(claudeCommand("plan", REVIEWER_ALLOWED_TOOLS, agent), "bash"), "")
  emit("CWD 规则（容器内路径，任务目录 = \`/workspace/<workingDirectory>\`）：", "")
  emit("- 实现 agent：\`/workspace/<workingDirectory>\`（任务目录本身，v0.2 无快照目录）")
  emit("- 评审 agent：\`/workspace/<workingDirectory>\`（任务目录本身，只读）")
  emit("- 其中 \`<safeTaskId>\` = 任务 id 小写并把非 \`[a-z0-9_.-]\` 字符替换为 \`-\`（docker.ts \`safeName\`）", "")
  emit("## 逐字 prompt 公式", "")
  emit("下列公式即 docker.ts 的运行时拼装（\`R\` = 轮次，\`FB\` = 上一轮评审 feedback 的逐字内容）：", "")
  emit(fence(
    "实现 agent stdin = loop.implementation.instruction\n" +
    "  + \"\\n\\n# Frozen node context\\nTask: <id>\\nRound: R/<maxRounds>\\n\"\n" +
    "  + (R == 1 ? \"This is the first round.\\n\"\n" +
    "            : \"Reviewer feedback from the prior round:\\n<FB>\\n\")\n" +
    "  + \"\\nYou own only: <implementation.scope 逗号连接>.\"\n\n" +
    "评审 agent stdin = loop.reviewer.instruction + 同一上下文块\n" +
    "  + \"\\nReview the implementation against the frozen node contract and its clause table. The machine evidence is:\n\"" +
    "  + <TEST_EVIDENCE>\n" +
    "  + \"\\nDo not edit any file. Your result must be exactly one JSON object and nothing else — no markdown fences, no prose before or after: {\\\"approved\\\":boolean,\\\"feedback\\\":\\\"specific changes keyed to clause ids where applicable\\\"}. Approve only when the implementation conforms to every clause and the review-kind clauses hold by inspection.\"\n\n" +
    "<TEST_EVIDENCE> = 每条评审命令的 \"$ <命令>\\nexit=<exitCode>\\n<stdout>\\n<stderr>\" 以空行连接（运行时数据，即编译器 oracle 的输出）",
  ), "")
  emit("评审输出必须**只**是那个 JSON 对象；解析见 docker.ts \`parseAgentEnvelope\`。未获 approved 则进入下一轮；轮次耗尽即任务失败（无修复回路）。挑战协议：实现 agent 的 result 若为 {\"challenge\":{\"clause\":…,\"reason\":…}}，run 以 SPEC_CONTRACT_CHALLENGED 终止，不重试。", "")
  emit("## 执行顺序总览", "")
  emit("| 层 | 节点 | 类型 | 说明 |")
  emit("| --- | --- | --- | --- |")
  for (const wave of waves) {
    for (const task of wave.tasks) {
      const kind = task.executor === "agent" ? "agent（≤3 轮 单writer/评审回路，v0.2）" : "materialize（非 agent）"
      emit(`| ${wave.depth} | \`${task.id}\` | ${kind} | ${task.objective ?? ""} |`)
    }
  }
  emit("")

  for (const wave of waves) {
    const isMaterialize = wave.tasks.every((task) => task.executor !== "agent")
    const heading = isMaterialize
      ? `## 第 ${wave.depth} 层 · materialize（非 agent）`
      : `## 第 ${wave.depth} 层 · ${wave.tasks.length} 个 agent 节点（可并行）`
    emit(heading, "")
    for (const task of wave.tasks) {
      emit(`### 节点 \`${task.id}\`${task.objective ? ` — ${task.objective}` : ""}`, "")
      emit("#### 元信息", "")
      emit(`- 任务目录（仓库相对）：\`${task.workingDirectory}\`；容器内：\`/workspace/${task.workingDirectory}\``)
      emit(`- 依赖：${(task.dependsOn ?? []).length ? task.dependsOn.map((id) => `\`${id}\``).join(", ") : "—"}`)
      if (task.executor === "agent") {
        emit(`- 轮次上限：${task.loop.maxRounds}（单 writer + 评审收尾；证据为编译器 oracle，逐轮冻结）`)
        emit(`- 实现 instruction sha256：\`${sha256(task.loop.implementation.instruction)}\``)
        emit(`- 评审 instruction sha256：\`${sha256(task.loop.reviewer.instruction)}\``)
        emit(`- spec 节点：${(task.specNodeIds ?? []).map((id) => `\`${id}\``).join(", ") || "—"}`)
        emit("- 评审证据命令（评审前在任务目录执行，输出进入评审 prompt）：", "")
        emit(fence(task.loop.reviewer.commands.join("\n"), "bash"), "")
      } else {
        const files = Object.keys(task.materializedFiles ?? {}).sort()
        emit(`- instruction：${JSON.stringify(task.instruction ?? "")}`)
        emit(`- 物化文件（${files.length} 个，内容见 plan.json 的 \`materializedFiles\`，逐字写入任务目录）：`, "")
        emit(fence(files.join("\n"), ""), "")
        if (task.acceptance?.commands?.length) {
          emit("- 验收命令：", "")
          emit(fence(task.acceptance.commands.join("\n"), "bash"), "")
        }
        emit("")
        continue
      }
      emit("")
      emit("#### 实现 agent · 第 1 轮完整 stdin（逐字）", "")
      emit(fence(writerPrompt(task, 1, undefined)), "")
      const reviewer = reviewerPromptParts(task, 1)
      emit("#### 评审 agent · 第 1 轮 stdin 模板（\`<TEST_EVIDENCE>\` 为运行时数据）", "")
      emit(fence(`${reviewer.head}<<TEST_EVIDENCE>>${reviewer.tail}`), "")
      emit(`#### 第 2–${task.loop.maxRounds} 轮 · 上下文块（其余逐字节不变）`, "")
      emit(fence(
        `\n\n# Frozen node context\nTask: ${task.id}\nRound: <轮次>/${task.loop.maxRounds}\nReviewer feedback from the prior round:\n<上一轮评审 verdict 的 feedback 字段逐字内容>\n`,
      ), "")
      emit("将第 1 轮对应 prompt 中的上下文块替换为上式（含 feedback）即可；角色指令与所有权行不变。", "")
    }
  }
  emit("## 逐字完整性", "")
  emit(`本文件由 \`scripts/export-agent-prompts.mjs\` 写出后立即回读校验：${agentWaves.reduce((sum, wave) => sum + wave.tasks.length, 0)} 个 agent 节点的实现/测试第 1 轮完整 stdin 与评审模板头尾必须逐字节命中，否则生成失败。每个角色的 instruction sha256 见各节点元信息，可独立复算。`, "")
  return `${lines.join("\n").trimEnd()}\n`
}

/** Heading counting must ignore prompt-internal markdown inside fences. */
function headingsOutsideFences(document, prefix) {
  let count = 0
  let fenced = false
  for (const line of document.split("\n")) {
    if (line.startsWith(FENCE)) {
      fenced = !fenced
      continue
    }
    if (!fenced && line.startsWith(prefix)) count++
  }
  return count
}

function verifyDocument(document, waves) {
  const failures = []
  let agentNodes = 0
  for (const wave of waves) {
    for (const task of wave.tasks) {
      if (task.executor !== "agent") continue
      agentNodes++
      const implementation = writerPrompt(task, 1, undefined)
      const reviewer = reviewerPromptParts(task, 1)
      if (!document.includes(implementation)) failures.push(`${task.id}: implementation round-1 stdin not verbatim in document`)
      if (!document.includes(reviewer.head)) failures.push(`${task.id}: reviewer template head not verbatim in document`)
      if (!document.includes(reviewer.tail)) failures.push(`${task.id}: reviewer template tail not verbatim in document`)
    }
  }
  const h2 = headingsOutsideFences(document, "## ")
  const h3 = headingsOutsideFences(document, "### ")
  const expectedH2 = 5 + waves.length
  const expectedH3 = waves.reduce((sum, wave) => sum + wave.tasks.length, 0)
  if (h2 !== expectedH2) failures.push(`heading count: expected ${expectedH2} '## ' sections (5 meta + ${waves.length} waves), found ${h2}`)
  if (h3 !== expectedH3) failures.push(`heading count: expected ${expectedH3} '### ' node sections, found ${h3}`)
  return { failures, agentNodes }
}

function crossCheckComposite(plan, byId, compositePath) {
  const composite = JSON.parse(readFileSync(compositePath, "utf8"))
  const compositeTasks = composite.dag?.tasks ?? composite.tasks ?? []
  const byCompositeId = new Map(compositeTasks.map((task) => [safeTaskId(task.id), task]))
  const drift = []
  let compared = 0
  for (const task of plan.tasks) {
    if (task.executor !== "agent") continue
    const current = byCompositeId.get(safeTaskId(task.id))
    if (!current?.loop) {
      drift.push(`${task.id}: missing from composite plan`)
      continue
    }
    compared++
    if (current.loop.implementation?.instruction !== task.loop.implementation.instruction) {
      drift.push(`${task.id} loop.implementation.instruction differs from current compiler`)
    }
    if (current.loop.reviewer?.instruction !== task.loop.reviewer.instruction) {
      drift.push(`${task.id} loop.reviewer.instruction differs from current compiler`)
    }
    if (current.loop.maxRounds !== task.loop.maxRounds) drift.push(`${task.id}: maxRounds differs`)
  }
  return { compared, drift }
}

const { planPath, outPath, title, composite } = parseArgs(process.argv.slice(2))
const { plan, byId } = loadPlan(planPath)
const agent = plan.environment?.agent
if (!agent?.model || !agent?.effort || agent?.maxTurns === undefined) fail("plan.environment.agent is incomplete")
const waves = computeWaves(plan.tasks, byId)
const document = buildDocument({
  plan,
  byId,
  planPath: path.relative(process.cwd(), path.resolve(planPath)) || planPath,
  title: title ?? `${plan.repository} — agent prompt 回放手册（run ${plan.runId}）`,
  agent,
  waves,
})
const { failures, agentNodes } = verifyDocument(document, waves)
if (failures.length > 0) {
  for (const failure of failures) console.error(`verify: ${failure}`)
  fail(`self-verification failed with ${failures.length} defect(s); document NOT written`)
}
writeFileSync(outPath, document, "utf8")
console.log(`wrote ${outPath}: ${waves.length} waves, ${plan.tasks.length} tasks (${agentNodes} agent), ${document.split("\n").length} lines — self-verification passed`)
if (composite) {
  const { compared, drift } = crossCheckComposite(plan, byId, composite)
  if (drift.length === 0) {
    console.log(`composite cross-check: ${compared} agent tasks identical to ${composite}`)
  } else {
    console.warn(`composite cross-check: DRIFT against ${composite}`)
    for (const entry of drift) console.warn(`  - ${entry}`)
  }
}
