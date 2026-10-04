<script setup lang="ts">
import type { ProjectFieldKey, ProjectReconciliation } from './project-reconcile'
import { reactive, watch } from 'vue'

type ReconciliationView = ProjectReconciliation & { pending: boolean, error: string }
const props = defineProps<{
  state: ReconciliationView
  stale: boolean
  disabled: boolean
}>()
const emit = defineEmits<{
  apply: [choices: Partial<Record<ProjectFieldKey, 'local' | 'server'>>]
  cancel: []
}>()
const choices = reactive<Partial<Record<ProjectFieldKey, 'local' | 'server'>>>({})
watch(() => props.state, () => {
  for (const key of Object.keys(choices) as ProjectFieldKey[]) {
    delete choices[key]
  }
}, { flush: 'sync' })
function display(value: unknown) {
  if (value === undefined) {
    return '（未设置）'
  }
  return JSON.stringify(value, null, 2)
}
function apply() {
  emit('apply', { ...choices })
}
</script>

<template>
  <section class="reconciliation" aria-label="配置冲突核对">
    <div class="section-heading">
      <h3>核对并保留草稿</h3>
      <span class="mono">v{{ state.baselineRevision }} → v{{ state.serverRevision }}</span>
    </div>
    <p v-if="state.pending" role="status" class="help">
      正在读取最新配置…
    </p>
    <p v-if="state.error" role="alert" class="message error">
      {{ state.error }} 可再次核对。
    </p>
    <p v-if="stale" role="alert" class="message error">
      草稿已修改，本次核对已失效。请重新核对。
    </p>
    <template v-if="!state.pending && !state.error">
      <p class="help">
        只读取服务器配置，不会保存。冲突字段必须明确选择；应用后仍需点击“保存项目”。
      </p>
      <article v-for="field in state.fields.filter(item => item.localChanged || item.serverChanged)" :key="field.key" class="reconciliation-field">
        <h4>{{ field.key }}</h4>
        <div v-if="field.conflict" class="reconciliation-choice">
          <label><input v-model="choices[field.key]" type="radio" value="local"> 保留我的修改</label>
          <label><input v-model="choices[field.key]" type="radio" value="server"> 采用服务器配置</label>
        </div>
        <details>
          <summary>{{ field.conflict ? '查看冲突值' : '查看变更值' }}</summary>
          <div class="reconciliation-values">
            <div><strong>编辑基准</strong><pre>{{ display(field.baseline) }}</pre></div>
            <div><strong>当前草稿</strong><pre>{{ display(field.local) }}</pre></div>
            <div><strong>服务器配置</strong><pre>{{ display(field.server) }}</pre></div>
          </div>
        </details>
      </article>
      <p v-if="!state.fields.some(item => item.localChanged || item.serverChanged)" class="help">
        本地草稿与服务器配置没有字段差异。
      </p>
    </template>
    <div class="reconciliation-actions">
      <button type="button" :disabled="disabled || stale || state.pending || !!state.error || state.fields.some(item => item.conflict && !choices[item.key])" @click="apply">
        应用到草稿
      </button>
      <button type="button" :disabled="disabled || state.pending" @click="emit('cancel')">
        取消核对
      </button>
    </div>
  </section>
</template>

<style scoped>
.reconciliation {
  padding: 12px;
  margin: 12px 0;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.reconciliation-field {
  padding-top: 10px;
  margin: 12px 0;
  border-top: 1px solid var(--line);
}

.reconciliation-field h4 {
  margin: 0 0 8px;
}

.reconciliation-choice {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 8px;
}

.reconciliation-values {
  display: grid;
  gap: 10px;
  margin-top: 10px;
}

pre {
  max-height: 160px;
  padding: 8px;
  margin: 4px 0 0;
  overflow: auto;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  background: var(--surface-muted);
}

.reconciliation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
</style>
