# figma-iconify

[English](README.md) | [简体中文](README.zh-CN.md)

Fetch icons from Figma, clean them into [Iconify](https://iconify.design/) JSON, and distribute them to every app that already understands Iconify, UnoCSS, or Tailwind.

```bash
pnpm add -D figma-iconify
pnpm exec figma-iconify init
export FIGMA_TOKEN=figu_xxx
pnpm exec figma-iconify sync
```

```html
<span class="i-brand-arrow-left text-primary"></span>
```

Figma stays the design source. Iconify JSON is the engineering source. Designers keep drawing in Figma; frontend never copies zip files or iconfont projects.

## Packages

| Package | Role |
| --- | --- |
| [`figma-iconify`](apps/cli) | CLI + public API |
| [`@icebreakers/figma-iconify`](packages/core) | Pipeline library |

## Commands

| Command | Purpose |
| --- | --- |
| `figma-iconify init` | Write `figma-iconify.config.ts` |
| `figma-iconify sync` | Fetch, clean, validate, export |
| `figma-iconify check` | Validate existing output without Figma |
| `figma-iconify preview` | Write a static HTML gallery |

`sync --json` prints `added`, `removed`, `changed`, `skipped`, `fileVersion`, and `outputFiles`. Validation failures exit non-zero and do not write a partial set.

## Config

```ts
import { defineConfig } from 'figma-iconify'

export default defineConfig({
  file: 'https://www.figma.com/design/<fileKey>/Icons',
  prefix: 'brand',
  pages: ['Icons'],
  output: {
    json: 'icons.json',
    svg: 'svg',
    jsonPackage: 'packages/icons',
    preview: 'preview.html',
  },
  validate: {
    width: 24,
    height: 24,
  },
})
```

Token comes from `FIGMA_TOKEN`. Do not put it in the config file.

## GitHub Action

```yaml
- uses: sonofmagic/figma-iconify@v1
  with:
    token: ${{ secrets.FIGMA_TOKEN }}
    commit: true
```

## Figma conventions

- Dedicated icon library file
- One component per icon, 24×24, English kebab-case names
- Monochrome; the pipeline rewrites fills to `currentColor`
- Draft layers start with `_` or `.`
- Publishing the Figma library is for other design files. Engineering syncs with this CLI.

## License

MIT
