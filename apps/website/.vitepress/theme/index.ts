import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import IconDemoGallery from './components/IconDemoGallery.vue'
import IconFormatDemo from './components/IconFormatDemo.vue'
import IconFormatScores from './components/IconFormatScores.vue'
import IconFormatToolbar from './components/IconFormatToolbar.vue'
import Layout from './Layout.vue'
import './tailwind.css'

export default {
  ...DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('IconDemoGallery', IconDemoGallery)
    app.component('IconFormatDemo', IconFormatDemo)
    app.component('IconFormatScores', IconFormatScores)
    app.component('IconFormatToolbar', IconFormatToolbar)
  },
} satisfies Theme
