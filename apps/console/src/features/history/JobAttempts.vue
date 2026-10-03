<script setup lang="ts">
import type { Job, JobEvent, Snapshot } from '@iconctl/console-contracts'
import { computed } from 'vue'

const props = defineProps<{
  job: Job
  snapshots: Snapshot[]
  busy: boolean
  labels: Record<string, string>
  date: (timestamp: number) => string
}>()
const emit = defineEmits<{ snapshot: [id: string] }>()
const history = computed(() => {
  const groups = new Map<number, { attempt: number, events: JobEvent[], snapshots: Snapshot[] }>()
  function group(attempt: number) {
    let value = groups.get(attempt)
    if (!value) {
      value = { attempt, events: [], snapshots: [] }
      groups.set(attempt, value)
    }
    return value
  }
  group(props.job.attempt)
  for (const event of props.job.events ?? []) {
    if (event.attempt !== undefined) {
      group(event.attempt).events.push(event)
    }
  }
  for (const snapshot of props.snapshots) {
    if (snapshot.jobId === props.job.id && snapshot.projectId === props.job.projectId) {
      group(snapshot.attempt ?? 1).snapshots.push(snapshot)
    }
  }
  return [...groups.values()].sort((a, b) => b.attempt - a.attempt)
})
const legacyEvents = computed(() => props.job.events?.filter(event => event.attempt === undefined) ?? [])
function runLink(event: JobEvent) {
  if (!event.runId || !/^\d+$/.test(event.runId)) {
    return undefined
  }
  const base = `https://github.com/${props.job.project.repository}/actions/runs/${event.runId}`
  return event.runAttempt && /^\d+$/.test(event.runAttempt) ? `${base}/attempts/${event.runAttempt}` : base
}
</script>

<template>
  <details class="attempt-history">
    <summary>尝试与快照</summary>
    <section v-for="group in history" :key="group.attempt" :aria-label="`第 ${group.attempt} 次尝试`">
      <h4>第 {{ group.attempt }} 次尝试 <span v-if="group.attempt === job.attempt">· 当前</span></h4>
      <p v-if="!group.events.length" class="help">
        此次尝试没有已记录的阶段。
      </p>
      <ol v-else>
        <li v-for="(event, index) in group.events" :key="index">
          {{ date(event.at) }} · {{ labels[event.stage] ?? event.stage }} · {{ labels[event.status] ?? event.status }}
          <a v-if="runLink(event)" :href="runLink(event)" target="_blank" rel="noopener noreferrer">Actions ↗</a>
          <small v-if="event.error" class="error-text">{{ event.error }}</small>
        </li>
      </ol>
      <div v-for="snapshot in group.snapshots" :key="snapshot.id" class="attempt-snapshot">
        <button class="text-button" :disabled="busy" @click="emit('snapshot', snapshot.id)">
          查看第 {{ group.attempt }} 次快照
        </button>
        <small>{{ date(snapshot.createdAt) }} · {{ snapshot.iconCount }} 个图标 · {{ snapshot.issues }} 个问题</small>
      </div>
      <p v-if="!group.snapshots.length" class="help">
        此次尝试未生成快照。
      </p>
    </section>
    <section v-if="legacyEvents.length" aria-label="旧阶段记录（未记录尝试号）">
      <h4>旧阶段记录（未记录尝试号）</h4>
      <ol>
        <li v-for="(event, index) in legacyEvents" :key="index">
          {{ date(event.at) }} · {{ labels[event.stage] ?? event.stage }} · {{ labels[event.status] ?? event.status }}
          <small v-if="event.error" class="error-text">{{ event.error }}</small>
        </li>
      </ol>
    </section>
    <p class="help">
      最多保留最近 500 条阶段记录；历史快照单独保存。
    </p>
  </details>
</template>

<style scoped>
.attempt-history {
  min-width: 260px;
  margin-top: 10px;
}

summary {
  cursor: pointer;
}

section {
  margin: 14px 0;
  border-top: 1px solid var(--line);
}

h4 {
  margin: 12px 0;
}

h4 span {
  font-weight: normal;
  color: var(--muted);
}

ol {
  padding-left: 18px;
}

li {
  margin: 10px 0;
}

li a {
  display: inline-block;
  margin-left: 6px;
}

.attempt-snapshot {
  margin: 12px 0;
}
</style>
