<script setup lang="ts">
import type { SnapshotOrigin, SnapshotOriginTarget } from './snapshot-origin'
import { jobLabels } from './task-filters'

defineProps<{ origin: SnapshotOrigin, locatable: boolean, busy: boolean, refreshing: boolean }>()
const emit = defineEmits<{ locate: [target: SnapshotOriginTarget], refresh: [] }>()
</script>

<template>
  <section class="snapshot-origin" aria-label="快照来源">
    <div class="origin-heading">
      <h3>快照来源</h3>
      <button v-if="origin.available" type="button" :disabled="busy || !locatable" @click="emit('locate', origin.target)">
        定位生成任务
      </button>
    </div>
    <template v-if="origin.available">
      <p>{{ origin.projectName }} · {{ jobLabels[origin.operation] ?? origin.operation }} · 第 {{ origin.target.attempt }} 次尝试 · 配置 {{ origin.revision ? `v${origin.revision}` : '未记录' }}</p>
      <dl>
        <dt>生成任务</dt>
        <dd><code>{{ origin.target.jobId }}</code></dd>
        <dt>来源仓库</dt>
        <dd>{{ origin.repository }}</dd>
        <dt>源码提交</dt>
        <dd>
          <a v-if="origin.sourceHref" :href="origin.sourceHref" target="_blank" rel="noopener noreferrer"><code>{{ origin.sourceCommit }}</code></a>
          <code v-else>{{ origin.sourceCommit || '未记录' }}</code>
        </dd>
        <dt>对应 Actions 记录</dt>
        <dd>
          <span v-if="!origin.runs.length" class="help">未记录对应执行链接；历史阶段可能已截断。</span>
          <a v-for="run in origin.runs" :key="run.href" :href="run.href" target="_blank" rel="noopener noreferrer">
            Run {{ run.id }}{{ run.attempt ? ` · 执行 ${run.attempt}` : '' }} ↗
          </a>
        </dd>
      </dl>
      <p v-if="!locatable" class="help">
        当前工作空间缺少任务所属项目，暂时无法定位。历史来源信息仍可查看。
      </p>
    </template>
    <template v-else>
      <p>来源任务暂不可用。快照内容仍可审核；重新读取工作空间后可再次查看关联。</p>
      <p>任务 <code>{{ origin.jobId }}</code></p>
    </template>
    <button v-if="!origin.available || !locatable" type="button" :disabled="refreshing" @click="emit('refresh')">
      {{ refreshing ? '正在读取…' : '重新读取工作空间' }}
    </button>
  </section>
</template>

<style scoped>
.snapshot-origin {
  padding: 16px;
  margin: 18px 0;
  overflow-wrap: anywhere;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.origin-heading {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

h3 {
  margin: 0;
  font-size: 15px;
}

p {
  margin: 10px 0;
  font-size: 13px;
}

dl {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 4px;
  margin-bottom: 0;
  font-size: 12px;
}

dt {
  margin-top: 8px;
  color: var(--muted);
}

dd {
  min-width: 0;
  margin-left: 0;
}

dd a {
  display: block;
  width: fit-content;
  max-width: 100%;
}
</style>
