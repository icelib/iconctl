import { defineConfig } from 'iconctl'

export default defineConfig({
  prefix: 'ice',
  sources: [
    {
      type: 'directory',
      dir: 'raw',
    },
  ],
  output: {
    json: 'icons.json',
    svg: 'svg',
    types: 'src/icon-names.ts',
    preview: 'preview.html',
    changelog: 'CHANGELOG.md',
  },
})
