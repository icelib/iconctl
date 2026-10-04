<script setup lang="ts">
import type { AttemptHistory, AttemptHistoryPage, Job, JobEvent, Snapshot } from '@iconctl/console-contracts'
import type { ComponentPublicInstance } from 'vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { api } from '../../api'
import { recordedRunUrl } from './snapshot-origin'

const props = defineProps<{
  job: Job
  snapshots: Snapshot[]
  busy: boolean
  labels: Record<string, string>
  date: (timestamp: number) => string
}>()
const emit = defineEmits<{ snapshot: [id: string] }>()
function localGroups() {
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
  return groups
}
const page = ref<AttemptHistoryPage>()
const loading = ref(false)
const loadError = ref('')
const cursor = ref<string>()
let generation = 0
let controller: AbortController | undefined
const history = computed(() => {
  const groups = localGroups()
  const add = (incoming: AttemptHistory) => {
    const current = groups.get(incoming.attempt)
    if (!current) {
      groups.set(incoming.attempt, {
        attempt: incoming.attempt,
        events: [...incoming.events],
        snapshots: [...incoming.snapshots],
      })
      return
    }
    const eventKeys = new Set(current.events.map(event => `${event.at}|${event.stage}|${event.status}|${event.attempt ?? ''}|${event.runId ?? ''}|${event.runAttempt ?? ''}|${event.error ?? ''}`))
    for (const event of incoming.events) {
      const key = `${event.at}|${event.stage}|${event.status}|${event.attempt ?? ''}|${event.runId ?? ''}|${event.runAttempt ?? ''}|${event.error ?? ''}`
      if (!eventKeys.has(key)) {
        current.events.push(event)
        eventKeys.add(key)
      }
    }
    const snapshotIds = new Set(current.snapshots.map(snapshot => snapshot.id))
    current.snapshots.push(...incoming.snapshots.filter(snapshot => !snapshotIds.has(snapshot.id)))
    current.snapshots.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
  }
  for (const incoming of page.value?.attempts ?? []) {
    add(incoming)
  }
  return [...groups.values()].sort((a, b) => b.attempt - a.attempt)
})
const legacyEvents = computed(() => {
  const all = [
    ...(props.job.events?.filter(event => event.attempt === undefined) ?? []),
    ...(page.value?.legacyEvents ?? []),
  ]
  const seen = new Set<string>()
  return all.filter((event) => {
    const key = `${event.at}|${event.stage}|${event.status}|${event.error ?? ''}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
})
const disclosure = ref<HTMLDetailsElement>()
const attempts = new Map<number, HTMLElement>()
function rememberAttempt(attempt: number, element: Element | ComponentPublicInstance | null) {
  if (element instanceof HTMLElement) {
    attempts.set(attempt, element)
  }
  else { attempts.delete(attempt) }
}
function reveal(attempt: number) {
  const target = attempts.get(attempt)
  if (!disclosure.value?.isConnected || !target?.isConnected || !disclosure.value.contains(target)) {
    return false
  }
  disclosure.value.open = true
  target.scrollIntoView({ block: 'center' })
  target.focus()
  return document.activeElement === target
}
function runLink(event: JobEvent) {
  return recordedRunUrl(props.job.project.repository, event.runId, event.runAttempt)
}
async function loadMore(reset = false) {
  if (loading.value) {
    return
  }
  if (!reset && page.value && !page.value.hasMore) {
    return
  }
  controller?.abort()
  const requestGeneration = ++generation
  const request = new AbortController()
  controller = request
  loading.value = true
  loadError.value = ''
  try {
    const query = new URLSearchParams({ limit: '5' })
    if (!reset && cursor.value) {
      query.set('cursor', cursor.value)
    }
    const result = await api<AttemptHistoryPage>(`jobs/${props.job.id}/history?${query}`, undefined, 'GET', { signal: request.signal })
    if (requestGeneration !== generation || request.signal.aborted) {
      return
    }
    if (reset || !page.value) {
      page.value = result
    }
    else {
      page.value = {
        ...result,
        attempts: [...page.value.attempts, ...result.attempts],
        legacyEvents: page.value.legacyEvents ?? result.legacyEvents,
      }
    }
    cursor.value = result.nextCursor
  }
  catch (cause) {
    if (requestGeneration === generation && !request.signal.aborted) {
      loadError.value = cause instanceof Error ? cause.message : '读取历史失败，请重试'
    }
  }
  finally {
    if (requestGeneration === generation) {
      loading.value = false
    }
  }
}
function onToggle(event: Event) {
  if ((event.target as HTMLDetailsElement).open && !page.value) {
    void loadMore(true)
  }
}
watch(() => props.job.id, () => {
  controller?.abort()
  generation++
  page.value = undefined
  cursor.value = undefined
  loading.value = false
  loadError.value = ''
})
onBeforeUnmount(() => controller?.abort())
defineExpose({ reveal })
</script>

<template>
  <details ref="disclosure" class="attempt-history" @toggle="onToggle">
    <summary>尝试与快照</summary>
    <section
      v-for="group in history"
      :id="`job-${job.id}-attempt-${group.attempt}`"
      :key="group.attempt"
      :ref="element => rememberAttempt(group.attempt, element)"
      :aria-label="`第 ${group.attempt} 次尝试`"
      tabindex="-1"
    >
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
    <p v-if="loadError" class="error-text" role="alert">
      {{ loadError }}
      <button class="text-button" type="button" :disabled="loading" @click="loadMore(!page)">
        重试读取历史
      </button>
    </p>
    <p v-if="page?.hasMore" class="history-more">
      <button type="button" :disabled="loading" @click="loadMore()">
        {{ loading ? '读取中…' : '加载更多尝试' }}
      </button>
    </p>
    <p v-else-if="loading" class="help" role="status">
      读取历史中…
    </p>
    <p class="help">
      最多保留最近 500 条阶段记录；历史快照单独保存。展开后可按需加载更早尝试。
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

section:focus {
  outline: 2px solid var(--blue);
  outline-offset: 4px;
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
