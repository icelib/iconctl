# Quick start

## 1. Install

```bash
pnpm add -D iconctl
```

## 2. Create a config

```bash
pnpm exec iconctl init
```

Or write `iconctl.config.ts` yourself:

```ts
import { defineConfig } from 'iconctl'

export default defineConfig({
  prefix: 'brand',
  sources: [
    {
      type: 'figma',
      file: 'https://www.figma.com/design/<fileKey>/Icons',
      pages: ['Icons'],
    },
  ],
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

A local folder is the zero-token path and produces the same Iconify JSON:

```ts
sources: [{ type: 'directory', dir: './raw-svg' }]
```

## 3. Token

For Figma, use [OAuth login and automatic renewal](/figma#oauth-login-and-automatic-renewal). After configuring your app, run `pnpm exec iconctl auth figma login`; subsequent syncs refresh tokens automatically. Directory sources need no credentials.

Alternatively, use a personal token, which requires manual replacement:

```bash
export FIGMA_TOKEN=figu_xxx
```

## 4. Sync

```bash
pnpm exec iconctl sync
```

CI:

```bash
pnpm exec iconctl sync --json
```

`--dry-run` skips icon outputs but may update authentication and caches. Validation errors exit non-zero and do not write a partial set.

## 5. Use the JSON

With `@iconify/tailwind4` or UnoCSS, point a custom collection at `icons.json` and use `i-brand-arrow-left`. That class is a CSS mask, not a font.

Two ways to get the JSON to other developers: ship it **in the app repo**, or publish an **installable package**. See [Distribute](/distribute).
