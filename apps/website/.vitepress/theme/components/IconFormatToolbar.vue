<script setup lang="ts">
import { useData } from 'vitepress'
import { computed } from 'vue'
import { compareIcons, formatColor, formatSize, symbolId } from '../data/format-demo-state'

const { lang } = useData()
const zh = computed(() => lang.value === 'zh-CN')
</script>

<template>
  <div class="fmt-bar" :style="{ color: formatColor }">
    <label class="fmt-bar__field">
      <span>{{ zh ? '颜色' : 'Color' }}</span>
      <input v-model="formatColor" type="color" :aria-label="zh ? '图标颜色' : 'Icon color'">
      <code>{{ formatColor }}</code>
    </label>
    <label class="fmt-bar__field">
      <span>{{ zh ? '尺寸' : 'Size' }} · {{ formatSize }}px</span>
      <input v-model.number="formatSize" type="range" min="16" max="48" step="2">
    </label>
    <p class="fmt-bar__note">
      {{ zh
        ? '改颜色：mask / 内联 / 运行时 / symbol / webfont 会变；img 和 CSS background 保持琥珀色。'
        : 'Change color: mask / inline / runtime / symbol / webfont follow; img and CSS background stay amber.' }}
    </p>
    <svg class="fmt-bar__sprite" aria-hidden="true">
      <symbol
        v-for="icon in compareIcons"
        :id="symbolId(icon.name)"
        :key="icon.name"
        :viewBox="`0 0 ${icon.width} ${icon.height}`"
        v-html="icon.body"
      />
    </svg>
  </div>
</template>

<style>
@font-face {
  font-family: iconctl-compare;
  font-style: normal;
  font-weight: 400;
  src: url('/demo/iconctl-compare.woff2') format('woff2');
  font-display: block;
}
</style>

<style scoped>
.fmt-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.25rem;
  align-items: end;
  margin: 1.25rem 0 1.75rem;
  scroll-margin-top: 5.5rem;
}

.fmt-bar__field {
  display: grid;
  gap: 0.35rem;
  font-size: 0.85rem;
}

.fmt-bar__field input[type='range'] {
  width: 10rem;
}

.fmt-bar__note {
  flex: 1 1 12rem;
  margin: 0;
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
}

.fmt-bar__sprite {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
}
</style>
