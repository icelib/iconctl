import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import IconDemoGallery from './components/IconDemoGallery.vue'
import IconFormatPlayground from './components/IconFormatPlayground.vue'
import Layout from './Layout.vue'
import './tailwind.css'

export default {
  ...DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('IconDemoGallery', IconDemoGallery)
    app.component('IconFormatPlayground', IconFormatPlayground)
  },
} satisfies Theme
