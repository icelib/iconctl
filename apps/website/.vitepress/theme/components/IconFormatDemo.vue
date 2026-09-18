<script setup lang="ts">
import type { FormatId } from '../data/format-scores'
import { Icon } from '@iconify/vue'
import { useData } from 'vitepress'
import { computed } from 'vue'
import icons from '../data/figma-demo.json'
import {
  compareIcons,
  dataUri,
  FORMAT_BAKED,
  formatColor,
  formatSize,
  symbolId,
} from '../data/format-demo-state'
import { WEBFONT_CODEPOINTS } from '../data/format-scores'

const props = defineProps<{
  scheme: FormatId
}>()

const { lang } = useData()
const zh = computed(() => lang.value === 'zh-CN')
const size = formatSize
const baked = FORMAT_BAKED

const snippet: Record<FormatId, string> = {
  mask: '<span class="i-demo-arrow-left"></span>',
  inline: '<svg viewBox="0 0 24 24" aria-hidden="true">…</svg>',
  runtime: '<Icon icon="demo:arrow-left" />',
  file: '<img src="arrow-left.svg" alt="" width="24" height="24">',
  background: '.icon { background: url("arrow-left.svg") center / contain no-repeat; }',
  symbol: '<svg><use href="#arrow-left" /></svg>',
  webfont: '<i class="icon-arrow-left"></i>',
}

const follows = computed(() => {
  const bakedColor = props.scheme === 'file' || props.scheme === 'background'
  if (zh.value) {
    return bakedColor ? '颜色写死，不跟取色器' : '跟着取色器'
  }
  return bakedColor ? 'Color baked in' : 'Follows the picker'
})
</script>

<template>
  <div class="fmt-demo" :style="{ color: formatColor }">
    <div class="fmt-demo__icons">
      <template v-for="icon in compareIcons" :key="`${scheme}-${icon.name}`">
        <svg
          v-if="scheme === 'inline'"
          class="fmt-demo__glyph"
          :viewBox="`0 0 ${icon.width} ${icon.height}`"
          :width="size"
          :height="size"
          aria-hidden="true"
          v-html="icon.body"
        />
        <img
          v-else-if="scheme === 'file'"
          class="fmt-demo__glyph"
          :src="dataUri(icon, baked)"
          :alt="icon.name"
          :width="size"
          :height="size"
        >
        <svg
          v-else-if="scheme === 'symbol'"
          class="fmt-demo__glyph"
          :width="size"
          :height="size"
          aria-hidden="true"
        >
          <use :href="`#${symbolId(icon.name)}`" />
        </svg>
        <span
          v-else-if="scheme === 'mask'"
          class="fmt-demo__glyph fmt-demo__mask"
          :style="{ 'width': `${size}px`, 'height': `${size}px`, '--fmt-uri': `url(${JSON.stringify(dataUri(icon, '#000'))})` }"
          :aria-label="icon.name"
        />
        <span
          v-else-if="scheme === 'background'"
          class="fmt-demo__glyph fmt-demo__bg"
          :style="{ 'width': `${size}px`, 'height': `${size}px`, '--fmt-uri': `url(${JSON.stringify(dataUri(icon, baked))})` }"
          :aria-label="icon.name"
        />
        <Icon
          v-else-if="scheme === 'runtime'"
          class="fmt-demo__glyph"
          :icon="`${icons.prefix}:${icon.name}`"
          :width="size"
          :height="size"
        />
        <span
          v-else
          class="fmt-demo__glyph fmt-demo__font"
          :style="{ fontSize: `${size}px` }"
          aria-hidden="true"
        >{{ WEBFONT_CODEPOINTS[icon.name] }}</span>
      </template>
    </div>
    <p class="fmt-demo__hint">
      {{ follows }}
    </p>
    <pre class="fmt-demo__code"><code>{{ snippet[scheme] }}</code></pre>
  </div>
</template>

<style scoped>
.fmt-demo {
  padding: 0.9rem 1rem;
  margin: 0.75rem 0 1.5rem;
  background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
}

.fmt-demo__icons {
  display: flex;
  flex-wrap: wrap;
  gap: 1.1rem;
  align-items: center;
}

.fmt-demo__glyph {
  display: block;
  flex: none;
}

.fmt-demo__mask {
  background-color: currentcolor;
  mask: var(--fmt-uri) center / contain no-repeat;
  mask: var(--fmt-uri) center / contain no-repeat;
}

.fmt-demo__bg {
  background: var(--fmt-uri) center / contain no-repeat;
}

.fmt-demo__font {
  font-family: iconctl-compare, sans-serif;
  font-style: normal;
  font-weight: 400;
  line-height: 1;
  -webkit-font-smoothing: antialiased;
}

.fmt-demo__hint {
  margin: 0.65rem 0 0;
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
}

.fmt-demo__code {
  padding: 0.55rem 0.7rem;
  margin: 0.5rem 0 0;
  overflow-x: auto;
  font-size: 0.8rem;
  background: var(--vp-c-bg);
  border-radius: 8px;
}

.fmt-demo__code code {
  font-size: inherit;
}
</style>
