import Tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitepress'
import { createNav, createSidebars } from './navigation/routes'

const github = 'https://github.com/sonofmagic/figma-iconify'

export default defineConfig({
  outDir: '.vitepress/dist',
  title: 'figma-iconify',
  titleTemplate: ':title — Figma to Iconify',
  description: 'Fetch Figma icons, convert them to Iconify JSON, and distribute them.',
  lastUpdated: true,
  cleanUrls: true,
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
      title: 'figma-iconify',
      description: 'Fetch Figma icons, convert them to Iconify JSON, and distribute them.',
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
      title: 'figma-iconify',
      description: '从 Figma 拉取图标，转成 Iconify JSON，再分发到各个系统。',
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
