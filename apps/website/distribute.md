# Distribute

`iconctl` publishes the **tool**. Your product icons are generated into your own repo.

## 1. JSON in the app repo

```ts
output: { json: 'src/icons.json' }
```

Point UnoCSS / Tailwind at that file. Ship the JSON with the app. How the class is painted (CSS mask vs inline SVG vs webfont) is on [Icon formats](/formats).

## 2. Iconify JSON package

```ts
output: {
  jsonPackage: 'packages/icons',
}
```

This uses Iconify's `@iconify-json/<prefix>` layout.

## 3. GitHub Action

```yaml
- uses: sonofmagic/iconctl@v1
  with:
    token: ${{ secrets.FIGMA_TOKEN }}
    commit: true
```

The action runs `iconctl sync --json`. If sources are unchanged, it exits 0 and writes nothing.

## Commands

| Command | Purpose |
| --- | --- |
| `iconctl init` | Write `iconctl.config.ts` |
| `iconctl sync` | Load sources, clean, validate, export |
| `iconctl check` | Validate existing SVG/JSON |
| `iconctl preview` | Write `preview.html` |

Library API:

```ts
import { defineConfig, loadConfig, sync } from 'iconctl'
```
