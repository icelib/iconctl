# Distribute

`figma-iconify` publishes the **tool**. Your product icons are generated into your own repo.

## 1. JSON in the app repo

```ts
output: { json: 'src/icons.json' }
```

Point UnoCSS / Tailwind at that file. Ship the JSON with the app.

## 2. Iconify JSON package

```ts
output: {
  jsonPackage: 'packages/icons',
}
```

This uses Iconify's `@iconify-json/<prefix>` layout. Publish that package and depend on it from every app.

## 3. GitHub Action

```yaml
- uses: sonofmagic/figma-iconify@v1
  with:
    token: ${{ secrets.FIGMA_TOKEN }}
    commit: true
```

The action runs `figma-iconify sync --json`. If the Figma file is unchanged, it exits 0 and writes nothing.

## Commands

| Command | Purpose |
| --- | --- |
| `figma-iconify init` | Write `figma-iconify.config.ts` |
| `figma-iconify sync` | Fetch, clean, validate, export |
| `figma-iconify check` | Validate existing SVG/JSON, no Figma call |
| `figma-iconify preview` | Write `preview.html` |

Library API:

```ts
import { defineConfig, sync, loadConfig } from 'figma-iconify'
```
