# App-repo JSON

Mode 1: icons live in the **same git repo as the app**. Designer Publish opens a PR; after merge, `git pull` is enough. No npm.

```bash
pnpm --filter @iconctl/example-app-json sync
```

Writes `src/icons.json`, `src/icon-names.ts`, `preview.html`, `CHANGELOG.md`.

## Tailwind (`@iconify/tailwind4`)

```ts
import { addDynamicIconSelectors } from '@iconify/tailwind4'
import icons from './src/icons.json'

addDynamicIconSelectors({
  prefix: 'i',
  iconSets: {
    brand: icons,
  },
})
```

```html
<span class="i-brand-arrow-left"></span>
```

## UnoCSS

```ts
import icons from './src/icons.json'
import { defineConfig, presetIcons } from 'unocss'

export default defineConfig({
  presets: [
    presetIcons({
      collections: {
        brand: icons,
      },
    }),
  ],
})
```

Same class: `i-brand-arrow-left`.
