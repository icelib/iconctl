<script setup lang="ts">
import type { SnapshotIssue } from '@iconctl/console-contracts'

defineProps<{ issues: SnapshotIssue[], failed: string[] }>()
const stages: Record<string, string> = {
  'export-url': '获取导出地址',
  'download': '下载',
  'import': '导入',
  'process': '加工',
  'validation': '校验',
  'validate': '校验',
}
function figmaLink(issue: SnapshotIssue) {
  if (issue.sourceType !== 'figma' || !issue.fileKey || !issue.nodeId) {
    return undefined
  }
  return `https://www.figma.com/file/${encodeURIComponent(issue.fileKey)}?node-id=${encodeURIComponent(issue.nodeId)}`
}
</script>

<template>
  <section v-if="issues.length || failed.length" class="validation-issues" aria-label="快照诊断">
    <h3>请先修复校验问题</h3>
    <article v-for="(issue, index) in issues" :key="index" class="diagnostic">
      <p><code>{{ issue.name }}</code> · {{ issue.message }}</p>
      <p class="diagnostic-context">
        阶段：{{ issue.stage ? (stages[issue.stage] ?? issue.stage) : '未记录' }}
        · 来源：{{ issue.sourceType ?? '未记录' }}<span v-if="issue.sourceIndex !== undefined"> #{{ issue.sourceIndex + 1 }}</span>
        <span v-if="issue.nodeId"> · 节点 {{ issue.nodeId }}</span>
        <a v-if="figmaLink(issue)" :href="figmaLink(issue)" target="_blank" rel="noopener noreferrer">在 Figma 中定位</a>
      </p>
    </article>
    <p v-for="name in failed" :key="name">
      处理失败：{{ name }}
    </p>
  </section>
</template>

<style scoped>
.diagnostic + .diagnostic {
  border-top: 1px solid #f1c8be;
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
