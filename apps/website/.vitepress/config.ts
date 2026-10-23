import type { DefaultTheme, HeadConfig } from 'vitepress'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import Tailwindcss from '@tailwindcss/vite'
import { defineConfigWithTheme } from 'vitepress'
import { createNav, createSidebars } from './navigation/routes'

const github = 'https://github.com/icelib/iconctl'
const channel = process.env.REPO_DOCS_CHANNEL ?? 'stable'
if (channel !== 'preview' && channel !== 'stable') {
  throw new Error('REPO_DOCS_CHANNEL must be preview or stable')
}
const isPreview = channel === 'preview'
const previewHead: HeadConfig[] = isPreview
  ? [['meta', { name: 'robots', content: 'noindex, nofollow' }]]
  : []

export default defineConfigWithTheme<DefaultTheme.Config & { docsPreview?: boolean }>({
  outDir: '.vitepress/dist',
  title: 'iconctl',
  titleTemplate: ':title — Icons to Iconify',
  description: 'Load icons from Figma, SVG directories, and more, then distribute Iconify JSON.',
  lastUpdated: true,
  cleanUrls: true,
  sitemap: isPreview
    ? undefined
    : { hostname: process.env.REPO_DOCS_URL || 'https://iconctl.icebreaker.top' },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/brand/repoctl-mark.svg' }],
    ...previewHead,
  ],
  themeConfig: {
    docsPreview: isPreview,
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: github }],
  },
  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      title: 'iconctl',
      description: 'Load icons from Figma, SVG directories, and more, then distribute Iconify JSON.',
      themeConfig: {
        nav: createNav('en'),
        sidebar: createSidebars('en'),
        editLink: {
          pattern: `${github}/edit/main/apps/website/:path`,
          text: 'Edit this page',
        },
      },
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      title: 'iconctl',
      description: '从 Figma、本地 SVG 以及更多来源拉取图标，转成 Iconify JSON 再分发。',
      themeConfig: {
        nav: createNav('zh'),
        sidebar: createSidebars('zh'),
        editLink: {
          pattern: `${github}/edit/main/apps/website/:path`,
          text: '为此页提供修改建议',
        },
      },
    },
  },
  vite: {
    plugins: [Tailwindcss()],
  },
  async buildEnd({ outDir }) {
    if (isPreview) {
      await Promise.all([
        writeFile(path.join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n'),
        writeFile(path.join(outDir, '_headers'), '/*\n  X-Robots-Tag: noindex, nofollow\n'),
      ])
    }
  },
})
