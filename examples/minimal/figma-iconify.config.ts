import { defineConfig } from 'figma-iconify'

export default defineConfig({
  file: 'https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Icons',
  prefix: 'brand',
  pages: ['Icons'],
  output: {
    json: 'icons.json',
    svg: 'svg',
    preview: 'preview.html',
  },
  validate: {
    width: 24,
    height: 24,
  },
})
