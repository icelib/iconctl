<script setup lang="ts">
import type { FormatId, ScoreId } from '../data/format-scores'
import { addCollection, Icon } from '@iconify/vue'
import { useData } from 'vitepress'
import { computed, ref } from 'vue'
import icons from '../data/figma-demo.json'
import {
  COMPARE_ICONS,
  FORMAT_IDS,
  formatScores,
  SCORE_IDS,
  WEBFONT_CODEPOINTS,
} from '../data/format-scores'

addCollection(icons)

interface DemoIcon {
  name: string
  body: string
  width: number
  height: number
}

const { lang } = useData()
const zh = computed(() => lang.value === 'zh-CN')
const color = ref('#3451b2')
const size = ref(32)
const baked = '#b45309'

const defaultWidth = icons.width ?? 24
const defaultHeight = icons.height ?? 24

const compareIcons = computed<DemoIcon[]>(() =>
  COMPARE_ICONS.map((name) => {
    const icon = icons.icons[name]
    return {
      name,
      body: icon.body,
      width: defaultWidth,
      height: defaultHeight,
    }
  }),
)

function svgMarkup(icon: DemoIcon, fillColor: string) {
  const body = icon.body.replaceAll('currentColor', fillColor)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.width} ${icon.height}" fill="none">${body}</svg>`
}

function dataUri(icon: DemoIcon, fillColor: string) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svgMarkup(icon, fillColor))}`
}

function symbolId(name: string) {
  return `iconctl-fmt-${name}`
}

const formatLabel: Record<FormatId, { en: string, zh: string }> = {
  inline: { en: 'Inline SVG', zh: '内联 SVG' },
  file: { en: 'SVG file', zh: 'SVG 文件' },
  symbol: { en: 'Symbol sprite', zh: 'Symbol 雪碧图' },
  mask: { en: 'CSS mask', zh: 'CSS mask' },
  background: { en: 'CSS background', zh: 'CSS background' },
  runtime: { en: 'Iconify runtime', zh: 'Iconify 运行时' },
  webfont: { en: 'Webfont', zh: 'Webfont' },
}

const formatHint: Record<FormatId, { en: string, zh: string }> = {
  inline: { en: 'Follows the picker', zh: '跟着取色器' },
  file: { en: 'Color baked in', zh: '颜色写死' },
  symbol: { en: 'Follows the picker', zh: '跟着取色器' },
  mask: { en: 'Follows the picker', zh: '跟着取色器' },
  background: { en: 'Color baked in', zh: '颜色写死' },
  runtime: { en: 'Follows the picker', zh: '跟着取色器' },
  webfont: { en: 'Demo font only — not an iconctl output', zh: '仅演示字体，不是 iconctl 产物' },
}

const scoreLabel: Record<ScoreId, { en: string, zh: string }> = {
  theme: { en: 'Theme / currentColor', zh: '跟随主题色' },
  multicolor: { en: 'Multi-color', zh: '多色' },
  treeshake: { en: 'Tree-shake', zh: '按需裁剪' },
  requests: { en: 'Requests / cache', zh: '请求与缓存' },
  alignment: { en: 'Alignment', zh: '对齐' },
  a11y: { en: 'Accessibility', zh: '无障碍' },
  miniprogram: { en: 'Mini program', zh: '小程序' },
  animation: { en: 'Animation', zh: '动画' },
  dx: { en: 'Class-sized DX', zh: 'class 写法' },
  fit: { en: 'Fit for iconctl apps', zh: '和 iconctl 的契合' },
}

function label(map: Record<string, { en: string, zh: string }>, id: string) {
  const entry = map[id]
  return zh.value ? entry.zh : entry.en
}

const scenarios = computed(() => zh.value
  ? [
      { when: 'Vite + UnoCSS / Tailwind', use: 'CSS mask，class i-{prefix}-{name}', avoid: '新做 webfont' },
      { when: '微信 / 支付宝 / 抖音', use: '同一套 class，CSS mask', avoid: '<use>、webfont、Iconify Vue' },
      { when: '图标少，要动画或多色 SVG', use: '内联 SVG 或 Iconify 运行时', avoid: 'mask（单色）、webfont' },
      { when: '多色 Logo / 插画', use: '<img>、CSS background，或位图', avoid: 'Iconify / mask' },
      { when: '已经在用 @iconify/vue 的公共图标集', use: 'Iconify 运行时', avoid: '再走一遍 iconctl' },
      { when: '现成的 iconfont Symbol CDN', use: '{ type: \'iconfont\' } 收进来，再用 mask 画', avoid: '继续发字体' },
      { when: '给设计和 QA 预览', use: '内联 SVG 画廊（iconctl preview / Demo）', avoid: '把预览当生产 API' },
    ]
  : [
      { when: 'Vite + UnoCSS / Tailwind', use: 'CSS mask, class i-{prefix}-{name}', avoid: 'A new webfont' },
      { when: 'WeChat / Alipay / Douyin', use: 'Same class names, CSS mask', avoid: '<use>, webfont, Iconify Vue' },
      { when: 'Few icons, motion or multi-color SVG', use: 'Inline SVG or Iconify runtime', avoid: 'Mask (monochrome), webfont' },
      { when: 'Multi-color logo / illustration', use: '<img>, CSS background, or a raster', avoid: 'Iconify / mask' },
      { when: 'Public set, already on @iconify/vue', use: 'Iconify runtime', avoid: 'Re-pipeline through iconctl' },
      { when: 'Legacy iconfont Symbol CDN', use: '{ type: \'iconfont\' }, then paint with mask', avoid: 'Keep shipping the font' },
      { when: 'Design / QA preview', use: 'Inline SVG gallery (iconctl preview / Demo)', avoid: 'Treating preview as the production API' },
    ])
</script>

<template>
  <div class="fmt" :style="{ color, '--fmt-size': `${size}px` }">
    <div class="fmt__toolbar">
      <label class="fmt__field">
        <span>{{ zh ? '颜色' : 'Color' }}</span>
        <input v-model="color" type="color" :aria-label="zh ? '图标颜色' : 'Icon color'">
        <code>{{ color }}</code>
      </label>
      <label class="fmt__field">
        <span>{{ zh ? '尺寸' : 'Size' }} · {{ size }}px</span>
        <input v-model.number="size" type="range" min="16" max="48" step="2">
      </label>
      <p class="fmt__note">
        {{ zh
          ? '改颜色：内联 / symbol / mask / 运行时 / webfont 会变；img 和 CSS background 保持琥珀色。'
          : 'Change color: inline / symbol / mask / runtime / webfont follow; img and CSS background stay amber.' }}
      </p>
    </div>

    <svg class="fmt__sprite" aria-hidden="true">
      <symbol
        v-for="icon in compareIcons"
        :id="symbolId(icon.name)"
        :key="icon.name"
        :viewBox="`0 0 ${icon.width} ${icon.height}`"
        v-html="icon.body"
      />
    </svg>

    <div
      v-for="id in FORMAT_IDS"
      :key="id"
      class="fmt__row"
    >
      <div class="fmt__meta">
        <strong>{{ label(formatLabel, id) }}</strong>
        <small>{{ label(formatHint, id) }}</small>
      </div>
      <div class="fmt__icons">
        <template v-for="icon in compareIcons" :key="`${id}-${icon.name}`">
          <svg
            v-if="id === 'inline'"
            class="fmt__glyph"
            :viewBox="`0 0 ${icon.width} ${icon.height}`"
            :width="size"
            :height="size"
            aria-hidden="true"
            v-html="icon.body"
          />
          <img
            v-else-if="id === 'file'"
            class="fmt__glyph"
            :src="dataUri(icon, baked)"
            :alt="icon.name"
            :width="size"
            :height="size"
          >
          <svg
            v-else-if="id === 'symbol'"
            class="fmt__glyph"
            :width="size"
            :height="size"
            aria-hidden="true"
          >
            <use :href="`#${symbolId(icon.name)}`" />
          </svg>
          <span
            v-else-if="id === 'mask'"
            class="fmt__glyph fmt__mask"
            :style="{ 'width': `${size}px`, 'height': `${size}px`, '--fmt-uri': `url(${JSON.stringify(dataUri(icon, '#000'))})` }"
            :aria-label="icon.name"
          />
          <span
            v-else-if="id === 'background'"
            class="fmt__glyph fmt__bg"
            :style="{ 'width': `${size}px`, 'height': `${size}px`, '--fmt-uri': `url(${JSON.stringify(dataUri(icon, baked))})` }"
            :aria-label="icon.name"
          />
          <Icon
            v-else-if="id === 'runtime'"
            class="fmt__glyph"
            :icon="`${icons.prefix}:${icon.name}`"
            :width="size"
            :height="size"
          />
          <span
            v-else
            class="fmt__glyph fmt__font"
            :style="{ fontSize: `${size}px` }"
            aria-hidden="true"
          >{{ WEBFONT_CODEPOINTS[icon.name] }}</span>
        </template>
      </div>
    </div>
  </div>

  <div class="fmt-scores">
    <h3>{{ zh ? '多维打分（1–5）' : 'Scores (1–5)' }}</h3>
    <p>
      {{ zh
        ? '没有总分。webfont 的 HTML 很短，加总会把它抬上去；那不是这套管线要的。最后一行是和 iconctl 应用的契合，不是宇宙排名。'
        : 'No grand total. Webfont’s tiny HTML would win a sum; that is not this pipeline. The last row is fit for iconctl apps, not a universal ranking.' }}
    </p>
    <div class="fmt-scores__wrap">
      <table>
        <thead>
          <tr>
            <th />
            <th v-for="id in FORMAT_IDS" :key="id">
              {{ label(formatLabel, id) }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="scoreId in SCORE_IDS" :key="scoreId">
            <th>{{ label(scoreLabel, scoreId) }}</th>
            <td v-for="id in FORMAT_IDS" :key="`${scoreId}-${id}`">
              <span class="fmt-scores__pips" :title="String(formatScores[scoreId][id])">
                <i
                  v-for="n in 5"
                  :key="n"
                  :class="{ on: n <= formatScores[scoreId][id] }"
                />
              </span>
              <span class="fmt-scores__n">{{ formatScores[scoreId][id] }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="fmt-when">
    <h3>{{ zh ? '什么场景用什么' : 'When to use what' }}</h3>
    <div class="fmt-scores__wrap">
      <table>
        <thead>
          <tr>
            <th>{{ zh ? '场景' : 'Situation' }}</th>
            <th>{{ zh ? '用' : 'Use' }}</th>
            <th>{{ zh ? '别用' : 'Avoid' }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in scenarios" :key="row.when">
            <td>{{ row.when }}</td>
            <td>{{ row.use }}</td>
            <td>{{ row.avoid }}</td>
          </tr>
        </tbody>
      </table>
    </div>
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
.fmt {
  margin: 1.5rem 0 2rem;
  scroll-margin-top: 5.5rem;
}

.fmt__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.25rem;
  align-items: end;
  margin-bottom: 1rem;
}

.fmt__field {
  display: grid;
  gap: 0.35rem;
  font-size: 0.85rem;
}

.fmt__field input[type='range'] {
  width: 10rem;
}

.fmt__note {
  flex: 1 1 12rem;
  margin: 0;
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
}

.fmt__sprite {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
}

.fmt__row {
  display: grid;
  grid-template-columns: minmax(8rem, 11rem) 1fr;
  gap: 0.75rem 1rem;
  align-items: center;
  padding: 0.7rem 0;
  border-top: 1px solid var(--vp-c-divider);
}

.fmt__meta {
  display: grid;
  gap: 0.15rem;
}

.fmt__meta small {
  font-size: 0.75rem;
  color: var(--vp-c-text-2);
}

.fmt__icons {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: center;
}

.fmt__glyph {
  display: block;
  flex: none;
}

.fmt__mask {
  background-color: currentcolor;
  mask: var(--fmt-uri) center / contain no-repeat;
  mask: var(--fmt-uri) center / contain no-repeat;
}

.fmt__bg {
  background: var(--fmt-uri) center / contain no-repeat;
}

.fmt__font {
  font-family: iconctl-compare, sans-serif;
  font-style: normal;
  font-weight: 400;
  line-height: 1;
  -webkit-font-smoothing: antialiased;
}

.fmt-scores,
.fmt-when {
  margin: 2rem 0;
}

.fmt-scores__wrap {
  overflow-x: auto;
}

.fmt-scores table,
.fmt-when table {
  width: 100%;
  font-size: 0.85rem;
}

.fmt-scores th,
.fmt-scores td,
.fmt-when th,
.fmt-when td {
  padding: 0.4rem 0.5rem;
  vertical-align: middle;
  white-space: nowrap;
}

.fmt-when td {
  white-space: normal;
}

.fmt-scores__pips {
  display: inline-flex;
  gap: 2px;
  margin-right: 0.35rem;
}

.fmt-scores__pips i {
  display: block;
  width: 7px;
  height: 7px;
  background: var(--vp-c-divider);
  border-radius: 99px;
}

.fmt-scores__pips i.on {
  background: var(--vp-c-brand-1);
}

.fmt-scores__n {
  font-variant-numeric: tabular-nums;
  color: var(--vp-c-text-2);
}

@media (max-width: 640px) {
  .fmt__row {
    grid-template-columns: 1fr;
  }
}
</style>
