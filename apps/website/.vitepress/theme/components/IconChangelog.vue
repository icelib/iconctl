<script setup lang="ts">
import icons from '@iconctl/icons'
import changelog from '@iconctl/icons/CHANGELOG.md?raw'
import { useData } from 'vitepress'
import { computed } from 'vue'
import { parseIconChangelog } from '../parse-icon-changelog'

type Kind = 'added' | 'removed' | 'changed'

interface IconRecord {
  body: string
  width?: number
  height?: number
}

const { lang } = useData()
const zh = computed(() => lang.value === 'zh-CN')
const days = computed(() => parseIconChangelog(changelog))
const defaultWidth = icons.width ?? 24
const defaultHeight = icons.height ?? 24
const iconMap = icons.icons as Record<string, IconRecord>

const labels: Record<Kind, { en: string, zh: string }> = {
  added: { en: 'Added', zh: '新增' },
  removed: { en: 'Removed', zh: '删除' },
  changed: { en: 'Changed', zh: '修改' },
}

function iconBody(name: string) {
  return iconMap[name]
}

function viewBox(name: string) {
  const icon = iconBody(name)
  return `0 0 ${icon?.width ?? defaultWidth} ${icon?.height ?? defaultHeight}`
}
</script>

<template>
  <div v-if="days.length" class="icon-changelog">
    <section v-for="day in days" :key="day.date" class="icon-changelog__day">
      <h3>{{ day.date }}</h3>
      <p
        v-for="kind in (['added', 'removed', 'changed'] as const)"
        v-show="day[kind].length"
        :key="kind"
        class="icon-changelog__row"
      >
        <span class="icon-changelog__kind">{{ zh ? labels[kind].zh : labels[kind].en }}</span>
        <span class="icon-changelog__names">
          <span v-for="name in day[kind]" :key="name" class="icon-changelog__name">
            <svg
              v-if="iconBody(name)"
              :viewBox="viewBox(name)"
              width="16"
              height="16"
              aria-hidden="true"
              v-html="iconBody(name)!.body"
            />
            <code>{{ name }}</code>
          </span>
        </span>
      </p>
    </section>
  </div>
  <p v-else class="icon-changelog__empty">
    {{ zh ? '还没有图标变更。' : 'No icon changes yet.' }}
  </p>
</template>

<style scoped>
.icon-changelog {
  margin: 1.5rem 0 2rem;
}

.icon-changelog__day {
  margin-bottom: 1.25rem;
}

.icon-changelog__day h3 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}

.icon-changelog__row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.75rem;
  align-items: center;
  margin: 0 0 0.45rem;
}

.icon-changelog__kind {
  min-width: 4.5rem;
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
}

.icon-changelog__names {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.6rem;
}

.icon-changelog__name {
  display: inline-flex;
  gap: 0.3rem;
  align-items: center;
}

.icon-changelog__name svg {
  display: block;
  color: var(--vp-c-brand-1);
}

.icon-changelog__name code {
  font-size: 0.8rem;
}

.icon-changelog__empty {
  color: var(--vp-c-text-2);
}
</style>
