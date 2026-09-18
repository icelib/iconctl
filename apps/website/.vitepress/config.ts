import Tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitepress'
import { createNav, createSidebars } from './navigation/routes'

const github = 'https://github.com/icelib/iconctl'

export default defineConfig({
  outDir: '.vitepress/dist',
  title: 'iconctl',
  titleTemplate: ':title — Icons to Iconify',
  description: 'Load icons from Figma, SVG directories, and more, then distribute Iconify JSON.',
  lastUpdated: true,
  cleanUrls: true,
  sitemap: {
    hostname: 'https://iconctl.icebreaker.top',
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/brand/repoctl-mark.svg' }],
  ],
  themeConfig: {
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
})
