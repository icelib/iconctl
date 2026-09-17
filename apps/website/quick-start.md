# Quick start

## 1. Install

```bash
pnpm add -D figma-iconify
```

## 2. Create a config

```bash
pnpm exec figma-iconify init
```

Or write `figma-iconify.config.ts` yourself:

```ts
import { defineConfig } from 'figma-iconify'

export default defineConfig({
  file: 'https://www.figma.com/design/<fileKey>/Icons',
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
```

## 3. Token

Create a Figma personal access token and export it. Never commit it.

```bash
export FIGMA_TOKEN=figu_xxx
```

## 4. Sync

```bash
pnpm exec figma-iconify sync
```

CI:

```bash
pnpm exec figma-iconify sync --json
```

`--dry-run` validates without writing. Validation errors exit non-zero and do not write a partial set.

## 5. Use the JSON

With `@iconify/tailwind4` or UnoCSS, point a custom collection at `icons.json` and use `i-brand-arrow-left`.
