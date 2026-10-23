<script setup lang="ts">
import { useData } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { computed } from 'vue'

const { Layout } = DefaultTheme
const { lang, theme } = useData()
const isPreview = computed(() => theme.value.docsPreview === true)
const stableDocsHref = computed(() => `https://iconctl.icebreaker.top${lang.value === 'zh-CN' ? '/zh/' : '/'}`)
const notFoundTitle = computed(() => lang.value === 'zh-CN' ? '页面不存在' : 'Page not found')
const notFoundBody = computed(() => lang.value === 'zh-CN'
  ? '这个地址不属于新的文档结构。请从开始、任务或参考章节继续。'
  : 'This address is not part of the new documentation structure. Continue with Start, Tasks, or Reference.')
</script>

<template>
  <Layout :class="{ 'docs-preview-layout': isPreview }">
    <template v-if="isPreview" #layout-top>
      <aside class="docs-preview-banner" :aria-label="lang === 'zh-CN' ? '文档预览' : 'Documentation preview'">
        <span>{{ lang === 'zh-CN' ? '预览文档 · 尚未正式发布' : 'Preview docs · Unreleased changes' }}</span>
        <a :href="stableDocsHref">{{ lang === 'zh-CN' ? '查看正式文档' : 'View stable docs' }}</a>
      </aside>
    </template>
    <template #not-found>
      <main class="repoctl-not-found">
        <p class="repoctl-not-found__code">
          404
        </p>
        <h1>{{ notFoundTitle }}</h1>
        <p>{{ notFoundBody }}</p>
        <a href="/">{{ lang === 'zh-CN' ? '返回首页' : 'Back to home' }}</a>
      </main>
    </template>
  </Layout>
</template>

<style scoped>
.docs-preview-layout {
  --vp-layout-top-height: 40px;
}

.docs-preview-banner {
  position: fixed;
  z-index: calc(var(--vp-z-index-nav) + 1);
  top: 0;
  right: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px 16px;
  height: var(--vp-layout-top-height);
  padding: 6px 16px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 13px;
  line-height: 20px;
}

.docs-preview-banner a {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
  text-underline-offset: 3px;
  white-space: nowrap;
}

@media (max-width: 639px) {
  .docs-preview-layout {
    --vp-layout-top-height: 64px;
  }

  .docs-preview-banner {
    flex-direction: column;
  }
}
</style>
