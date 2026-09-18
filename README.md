# iconctl

[English](README.md) | [简体中文](README.zh-CN.md)

Load icons from Figma, a local SVG folder, or later other design tools, clean them into [Iconify](https://iconify.design/) JSON, and distribute them to every app that already understands Iconify, UnoCSS, or Tailwind.

```bash
pnpm add -D iconctl
pnpm exec iconctl init
pnpm exec iconctl sync
```

```html
<span class="i-brand-arrow-left text-primary"></span>
```

Iconify JSON is the engineering source. Figma is one input, not the product.

## Packages

| Package | Role |
| --- | --- |
| [`iconctl`](apps/cli) | CLI + public API |
| [`@icebreakers/iconctl`](packages/core) | Pipeline library |

## Commands

| Command | Purpose |
| --- | --- |
| `iconctl init` | Write `iconctl.config.ts` |
| `iconctl sync` | Load sources, clean, validate, export |
| `iconctl check` | Validate existing output without remote sources |
| `iconctl preview` | Write a static HTML gallery |

`sync --json` prints `added`, `removed`, `changed`, `skipped`, `sources`, `fileVersion`, and `outputFiles`. Validation failures exit non-zero and do not write a partial set.

## Config

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
    {
      type: 'directory',
      dir: './raw-svg',
    },
  ],
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

Figma sources read `FIGMA_TOKEN`. Directory sources need no token.

## GitHub Action

```yaml
- uses: sonofmagic/iconctl@v1
  with:
    token: ${{ secrets.FIGMA_TOKEN }}
    commit: true
```

## License

MIT
