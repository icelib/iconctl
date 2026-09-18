<script setup lang="ts">
import type { FormatId, ScoreId } from '../data/format-scores'
import { useData } from 'vitepress'
import { computed } from 'vue'
import {
  FORMAT_IDS,
  formatScores,
  SCORE_IDS,
} from '../data/format-scores'

const { lang } = useData()
const zh = computed(() => lang.value === 'zh-CN')

const formatLabel: Record<FormatId, { en: string, zh: string }> = {
  mask: { en: 'CSS mask', zh: 'CSS mask' },
  inline: { en: 'Inline SVG', zh: '内联 SVG' },
  runtime: { en: 'Iconify runtime', zh: 'Iconify 运行时' },
  file: { en: 'SVG file', zh: 'SVG 文件' },
  background: { en: 'CSS background', zh: 'CSS background' },
  symbol: { en: 'Symbol', zh: 'Symbol' },
  webfont: { en: 'Webfont', zh: 'Webfont' },
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
  <div class="fmt-scores">
    <h2>{{ zh ? '多维打分（1–5）' : 'Scores (1–5)' }}</h2>
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
    <h2>{{ zh ? '什么场景用什么' : 'When to use what' }}</h2>
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

<style scoped>
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
</style>
