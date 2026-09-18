import { addCollection } from '@iconify/vue'
import { computed, ref } from 'vue'
import icons from './figma-demo.json'
import { COMPARE_ICONS } from './format-scores'

addCollection(icons)

export interface DemoIcon {
  name: string
  body: string
  width: number
  height: number
}

export const formatColor = ref('#3451b2')
export const formatSize = ref(32)
export const FORMAT_BAKED = '#b45309'

const defaultWidth = icons.width ?? 24
const defaultHeight = icons.height ?? 24

export const compareIcons = computed<DemoIcon[]>(() =>
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

export function symbolId(name: string) {
  return `iconctl-fmt-${name}`
}

export function svgMarkup(icon: DemoIcon, fillColor: string) {
  const body = icon.body.replaceAll('currentColor', fillColor)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.width} ${icon.height}" fill="none">${body}</svg>`
}

export function dataUri(icon: DemoIcon, fillColor: string) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svgMarkup(icon, fillColor))}`
}
