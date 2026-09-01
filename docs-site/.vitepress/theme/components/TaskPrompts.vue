<script setup lang="ts">
import { ref } from "vue"
import promptData from "../../data/booking-task-prompts.json"

const root = ref<HTMLElement>()

function setAll(open: boolean): void {
  root.value?.querySelectorAll("details").forEach((item) => {
    item.open = open
  })
}

function dependencies(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "none"
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value)
}
</script>

<template>
  <div ref="root" class="task-prompts">
    <div class="task-prompt-toolbar" aria-label="Prompt display controls">
      <span>{{ promptData.tasks.length }} compiler-generated prompts</span>
      <div class="task-prompt-actions">
        <button type="button" @click="setAll(true)">Expand all</button>
        <button type="button" @click="setAll(false)">Collapse all</button>
      </div>
    </div>

    <details v-for="task in promptData.tasks" :key="task.id" class="task-prompt">
      <summary>
        <code>{{ task.id }}</code>
        <span>{{ task.lines }} lines, {{ formatNumber(task.characters) }} characters</span>
      </summary>
      <dl>
        <div>
          <dt>Depends on</dt>
          <dd>{{ dependencies(task.dependsOn) }}</dd>
        </div>
        <div>
          <dt>Writable scope</dt>
          <dd><code>{{ task.scope.join(", ") }}</code></dd>
        </div>
        <div>
          <dt>SHA-256</dt>
          <dd><code>{{ task.promptSha256 }}</code></dd>
        </div>
      </dl>
      <pre><code>{{ task.prompt }}</code></pre>
    </details>
  </div>
</template>

<style scoped>
.task-prompts {
  margin: 20px 0 28px;
}

.task-prompt-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  color: var(--vp-c-text-2);
  font-size: 13px;
}

.task-prompt-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.task-prompt-actions button {
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 5px 9px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  cursor: pointer;
  font: inherit;
}

.task-prompt-actions button:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.task-prompt {
  border-top: 1px solid var(--vp-c-divider);
}

.task-prompt:last-child {
  border-bottom: 1px solid var(--vp-c-divider);
}

.task-prompt summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 2px;
  cursor: pointer;
  color: var(--vp-c-text-1);
}

.task-prompt summary span {
  color: var(--vp-c-text-2);
  font-size: 12px;
  text-align: right;
}

.task-prompt dl {
  margin: 0 0 12px;
  padding: 10px 12px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
}

.task-prompt dl div {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 10px;
  padding: 3px 0;
}

.task-prompt dt {
  color: var(--vp-c-text-2);
  font-weight: 600;
}

.task-prompt dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.task-prompt pre {
  max-height: 640px;
  margin: 0 0 16px;
  padding: 16px;
  overflow: auto;
  border-radius: 6px;
  background: var(--vp-code-block-bg);
  color: var(--vp-code-block-color);
  font-size: 12px;
  line-height: 1.6;
}

@media (max-width: 640px) {
  .task-prompt-toolbar,
  .task-prompt summary {
    align-items: flex-start;
    flex-direction: column;
  }

  .task-prompt summary span {
    text-align: left;
  }

  .task-prompt dl div {
    grid-template-columns: 1fr;
    gap: 0;
  }
}
</style>
