import type { DefaultTheme } from 'vitepress'

export type DocsLocale = 'en' | 'zh'

interface LocalizedText {
  en: string
  zh: string
}

export interface RouteItem {
  slug: string
  label: LocalizedText
}

export interface RouteSection {
  id: 'guide'
  label: LocalizedText
  items: readonly RouteItem[]
}

const item = (slug: string, en: string, zh: string): RouteItem => ({ slug, label: { en, zh } })

export const routeSections = [
  {
    id: 'guide',
    label: { en: 'Guide', zh: '指南' },
    items: [
      item('', 'Introduction', '介绍'),
      item('quick-start', 'Quick start', '快速开始'),
      item('figma', 'Figma conventions', 'Figma 约定'),
      item('publish', 'Publish', '发布'),
      item('demo', 'Demo', '演示'),
      item('sources', 'Other sources', '其他来源'),
      item('distribute', 'Distribute', '分发'),
      item('formats', 'Icon formats', '图标方案'),
      item('miniprogram', 'Mini programs', '小程序'),
    ],
  },
] as const satisfies readonly RouteSection[]

export function routePath(locale: DocsLocale, slug: string) {
  const base = locale === 'zh' ? '/zh' : ''
  if (!slug) {
    return locale === 'zh' ? '/zh/' : '/'
  }
  return `${base}/${slug}`
}

export function createNav(locale: DocsLocale): DefaultTheme.NavItem[] {
  return [
    {
      text: locale === 'zh' ? '指南' : 'Guide',
      link: routePath(locale, 'quick-start'),
      activeMatch: locale === 'zh' ? '^/zh/(?!demo)' : '^/(?!zh/|demo)',
    },
    {
      text: locale === 'zh' ? '演示' : 'Demo',
      link: routePath(locale, 'demo'),
    },
  ]
}

export function createSidebars(locale: DocsLocale): DefaultTheme.Sidebar {
  return [
    {
      text: routeSections[0].label[locale],
      items: routeSections[0].items.map(entry => ({
        text: entry.label[locale],
        link: routePath(locale, entry.slug),
      })),
    },
  ]
}
