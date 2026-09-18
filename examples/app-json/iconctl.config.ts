import { defineConfig } from 'iconctl'

export default defineConfig({
  prefix: 'brand',
  sources: [{ type: 'directory', dir: 'raw' }],
  output: {
    json: 'src/icons.json',
    types: 'src/icon-names.ts',
    preview: 'preview.html',
    changelog: 'CHANGELOG.md',
  },
  validate: {
    width: 24,
    height: 24,
  },
})
