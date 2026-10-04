<script setup lang="ts">
import type { SnapshotContent } from '@iconctl/console-contracts'
import { computed } from 'vue'
import { projectSnapshotSources, snapshotSourceStatusLabel } from './snapshot-sources'

const props = defineProps<{ sources?: SnapshotContent['sources'] }>()
const projected = computed(() => projectSnapshotSources(props.sources))
</script>

<template>
  <section class="snapshot-sources" aria-label="快照来源记录">
    <h3>来源记录</h3>
    <p v-if="projected === undefined" class="help">
      此快照未记录来源（旧快照）。
    </p>
    <p v-else-if="!projected.length" class="help">
      此快照没有来源记录。
    </p>
    <ol v-else>
      <li v-for="source in projected" :key="source.index">
        <strong>来源 {{ source.index + 1 }}</strong>
        <span class="source-type">{{ source.type }}</span>
        <span class="source-field">文件标识：<code>{{ source.fileKey }}</code></span>
        <span class="source-field">状态：{{ snapshotSourceStatusLabel(source.status) }}</span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.snapshot-sources {
  padding: 16px;
  margin: 18px 0;
  overflow-wrap: anywhere;
  border: 1px solid var(--line);
  border-radius: 8px;
}

h3 {
  margin: 0 0 10px;
  font-size: 15px;
}

ol {
  display: grid;
  gap: 8px;
  padding-left: 24px;
  margin: 0;
}

li {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
}

.source-type {
  color: var(--muted);
}

.source-field {
  font-size: 12px;
}
</style>
