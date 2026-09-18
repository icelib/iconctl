<script setup lang="ts">
import { useData } from 'vitepress'
import { computed, ref } from 'vue'
import icons from '../data/figma-demo.json'

interface DemoIcon {
  name: string
  body: string
  width: number
  height: number
}

const { lang } = useData()
const zh = computed(() => lang.value === 'zh-CN')
const query = ref('')
const color = ref('#3451b2')
const copied = ref<string | null>(null)

const prefix = icons.prefix
const defaultWidth = icons.width ?? 24
const defaultHeight = icons.height ?? 24

const allIcons = computed<DemoIcon[]>(() =>
  Object.entries(icons.icons)
    .map(([name, icon]) => ({
      name,
      body: icon.body,
      width: defaultWidth,
      height: defaultHeight,
    }))
    .sort((left, right) => left.name.localeCompare(right.name)),
)

const visibleIcons = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) {
    return allIcons.value
  }
  return allIcons.value.filter(icon => icon.name.includes(needle) || `${prefix}:${icon.name}`.includes(needle))
})

function className(name: string) {
  return `i-${prefix}-${name}`
}

async function copyName(name: string) {
  const value = className(name)
  try {
    await navigator.clipboard.writeText(value)
  }
  catch {
    return
  }
  copied.value = name
  window.setTimeout(() => {
    if (copied.value === name) {
      copied.value = null
    }
  }, 1200)
}
</script>

<template>
  <div class="icon-demo" :style="{ color }">
    <div class="icon-demo__toolbar">
      <label class="icon-demo__field">
        <span>{{ zh ? '搜索' : 'Search' }}</span>
        <input
          v-model="query"
          type="search"
          :placeholder="zh ? '名称或前缀' : 'name or prefix'"
        >
      </label>
      <label class="icon-demo__field icon-demo__field--color">
        <span>{{ zh ? '颜色' : 'Color' }}</span>
        <input v-model="color" type="color" :aria-label="zh ? '图标颜色' : 'Icon color'">
        <code>{{ color }}</code>
      </label>
      <p class="icon-demo__count">
        {{ visibleIcons.length }} / {{ allIcons.length }}
        {{ zh ? '个图标' : 'icons' }}
        ·
        {{ prefix }}
      </p>
    </div>

    <div class="icon-demo__grid">
      <button
        v-for="icon in visibleIcons"
        :key="icon.name"
        type="button"
        class="icon-demo__item"
        :title="zh ? `复制 ${className(icon.name)}` : `Copy ${className(icon.name)}`"
        @click="copyName(icon.name)"
      >
        <svg
          :viewBox="`0 0 ${icon.width} ${icon.height}`"
          width="32"
          height="32"
          aria-hidden="true"
          v-html="icon.body"
        />
        <span>{{ prefix }}:{{ icon.name }}</span>
        <small>{{ copied === icon.name ? (zh ? '已复制' : 'Copied') : className(icon.name) }}</small>
      </button>
    </div>
  </div>
</template>

<style scoped>
.icon-demo {
  margin: 1.5rem 0 2rem;
  scroll-margin-top: 5.5rem;
}

.icon-demo__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.25rem;
  align-items: end;
  margin-bottom: 1rem;
}

.icon-demo__field {
  display: grid;
  gap: 0.35rem;
  font-size: 0.85rem;
}

.icon-demo__field input[type='search'] {
  min-width: 16rem;
  padding: 0.4rem 0.6rem;
  background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}

.icon-demo__field--color {
  grid-template-columns: auto auto;
  align-items: center;
}

.icon-demo__field--color span {
  grid-column: 1 / -1;
}

.icon-demo__field--color code {
  font-size: 0.75rem;
}

.icon-demo__count {
  margin: 0 0 0.2rem auto;
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
}

.icon-demo__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}

.icon-demo__item {
  display: grid;
  gap: 0.4rem;
  justify-items: center;
  padding: 12px 8px;
  margin: 0;
  color: inherit;
  text-align: center;
  cursor: pointer;
  background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
}

.icon-demo__item:hover,
.icon-demo__item:focus-visible {
  border-color: var(--vp-c-brand-1);
}

.icon-demo__item svg {
  display: block;
}

.icon-demo__item span,
.icon-demo__item small {
  font-size: 12px;
  line-height: 1.3;
  word-break: break-all;
}

.icon-demo__item span {
  color: var(--vp-c-text-1);
}

.icon-demo__item small {
  color: var(--vp-c-text-2);
}

@media (max-width: 640px) {
  .icon-demo__field input[type='search'] {
    min-width: 100%;
  }

  .icon-demo__count {
    margin-left: 0;
  }
}
</style>
