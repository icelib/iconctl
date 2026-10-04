<script setup lang="ts">
import type { SnapshotIssue } from '@iconctl/console-contracts'
import type { DiagnosticCopy } from './diagnostic-copy'
import type { DiagnosticIdentity, DiagnosticTarget } from './snapshot-diagnostics'
import { computed, onUnmounted, ref, watch } from 'vue'
import { allDiagnostics, diagnosticFigmaUrl, diagnosticIdentityError, diagnosticIdentityKey, diagnosticProjection, diagnosticTargetKey } from './snapshot-diagnostics'

const props = defineProps<{ snapshot: DiagnosticIdentity, issues: SnapshotIssue[], failed: string[], blocked: boolean, copy: DiagnosticCopy }>()
const stage = ref(allDiagnostics)
const source = ref(allDiagnostics)
const identity = computed(() => diagnosticIdentityKey(props.snapshot))
const identityError = computed(() => diagnosticIdentityError(props.snapshot))
const projection = computed(() => diagnosticProjection(props.issues, { stage: stage.value, source: source.value }))
const issueRows = computed(() => projection.value.rows.map(row => ({ ...row, target: { identity: identity.value, kind: 'issue' as const, index: row.index } })))
const failedRows = computed(() => props.failed.map((name, index) => ({ name, target: { identity: identity.value, kind: 'failed' as const, index } })))
const copyState = props.copy.state
const manualText = ref<HTMLTextAreaElement>()
const hasFilters = computed(() => !!stage.value || !!source.value)
function clearFilters() {
  stage.value = allDiagnostics
  source.value = allDiagnostics
}
watch(identity, () => {
  clearFilters()
  props.copy.invalidate()
}, { flush: 'sync' })
watch([stage, source], () => props.copy.invalidate(), { flush: 'sync' })
onUnmounted(() => props.copy.invalidate())
function act(target: DiagnosticTarget, manual = false) {
  if (props.blocked || identityError.value
    || ![...issueRows.value, ...failedRows.value].some(row => row.target === target)) {
    return
  }
  if (manual) {
    props.copy.showText(target)
  }
  else { void props.copy.start(target) }
}
function selectText() {
  if (!props.blocked && copyState.value.text) {
    manualText.value?.focus()
    manualText.value?.select()
  }
}
</script>

<template>
  <section v-if="issues.length || failed.length" class="validation-issues" aria-label="快照诊断">
    <h3>请先修复校验问题</h3>
    <p aria-label="完整诊断计数">
      问题 {{ issues.length }} 条 · 处理失败 {{ failed.length }} 项
    </p>
    <div v-if="issues.length" class="diagnostic-filters">
      <label>问题阶段
        <select v-model="stage" :disabled="blocked">
          <option :value="allDiagnostics">全部阶段（{{ issues.length }}）</option>
          <option v-for="option in projection.stages" :key="option.key" :value="option.key">{{ option.label }}（{{ option.count }}）</option>
        </select>
      </label>
      <label>问题来源
        <select v-model="source" :disabled="blocked">
          <option :value="allDiagnostics">全部来源（{{ issues.length }}）</option>
          <option v-for="option in projection.sources" :key="option.key" :value="option.key">{{ option.label }}（{{ option.count }}）</option>
        </select>
      </label>
      <button :disabled="blocked || !hasFilters" @click="clearFilters">
        清除诊断筛选
      </button>
    </div>
    <p aria-label="可见诊断计数">
      显示 {{ issueRows.length }} / {{ issues.length }} 条问题
    </p>
    <p v-if="identityError" role="status">
      {{ identityError }}
    </p>
    <p v-if="copyState.pending" role="status">
      正在完成上一次复制请求；仍可显示定位文本
    </p>
    <p v-if="issues.length && !issueRows.length">
      当前筛选没有匹配的问题
    </p>
    <article v-for="row in issueRows" :key="diagnosticTargetKey(row.target)" class="diagnostic" :aria-label="`问题 ${row.index + 1}`">
      <p><code>{{ row.issue.name }}</code> · {{ row.issue.message }}</p>
      <p class="diagnostic-context">
        阶段：{{ row.stage.label }} · 来源：{{ row.source.label }}
        <span v-if="row.issue.fileKey"> · 文件 {{ row.issue.fileKey }}</span>
        <span v-if="row.issue.nodeId"> · 节点 {{ row.issue.nodeId }}</span>
        <a v-if="diagnosticFigmaUrl(row.issue)" :href="diagnosticFigmaUrl(row.issue)" target="_blank" rel="noopener noreferrer">在 Figma 中定位</a>
        <span v-else-if="row.issue.sourceType === 'figma'"> · 未记录可用设计链接</span>
      </p>
      <div class="diagnostic-actions">
        <button :disabled="blocked || !!identityError || copyState.pending" @click="act(row.target)">
          复制定位信息
        </button>
        <button :disabled="blocked || !!identityError" @click="act(row.target, true)">
          显示定位文本
        </button>
      </div>
    </article>
    <section v-if="failed.length" aria-label="处理失败记录">
      <h4>处理失败（{{ failed.length }}）</h4>
      <p>这些记录未记录阶段和来源，始终显示，不受诊断筛选影响。</p>
      <article v-for="row in failedRows" :key="diagnosticTargetKey(row.target)" class="diagnostic" :aria-label="`处理失败 ${row.target.index + 1}`">
        <p>处理失败：{{ row.name }}</p>
        <div class="diagnostic-actions">
          <button :disabled="blocked || !!identityError || copyState.pending" @click="act(row.target)">
            复制定位信息
          </button>
          <button :disabled="blocked || !!identityError" @click="act(row.target, true)">
            显示定位文本
          </button>
        </div>
      </article>
    </section>
    <div class="diagnostic-copy" aria-label="定位复制状态" aria-live="polite">
      <p v-if="copyState.error" role="alert">
        {{ copyState.error }}
      </p>
      <p v-if="copyState.message">
        {{ copyState.message }}
      </p>
      <template v-if="copyState.text">
        <p>选择定位文本后，使用 Ctrl/Cmd+C 手动复制。</p>
        <label>定位文本<textarea ref="manualText" :value="copyState.text" readonly spellcheck="false" /></label>
        <button :disabled="blocked" @click="selectText">
          选择定位文本
        </button>
      </template>
    </div>
  </section>
</template>

<style scoped>
.diagnostic + .diagnostic {
  border-top: 1px solid #f1c8be;
}

.diagnostic {
  padding-block: 8px;
  overflow-wrap: anywhere;
}

.diagnostic-filters,
.diagnostic-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: end;
}

.diagnostic-filters label {
  flex: 1 1 180px;
  min-width: 0;
}

.diagnostic-filters select,
.diagnostic-copy textarea {
  box-sizing: border-box;
  display: block;
  width: 100%;
  max-width: 100%;
}

.diagnostic-copy textarea {
  min-height: 180px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  resize: vertical;
}

.diagnostic-copy {
  overflow-wrap: anywhere;
}

.diagnostic-context {
  font-size: 12px;
  overflow-wrap: anywhere;
}

.diagnostic-context a {
  display: inline-block;
  margin-left: 12px;
}
</style>
