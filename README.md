# iconctl

[English](README.md) | [简体中文](README.zh-CN.md)

Load icons from Figma, a local SVG folder, or later other design tools, clean them into [Iconify](https://iconify.design/) JSON, and distribute them to every app that already understands Iconify, UnoCSS, or Tailwind.

Docs: https://iconctl.icebreaker.top

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
| [`@iconctl/core`](packages/core) | Pipeline library |

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
    {
      type: 'mastergo',
      file: 'https://mastergo.com/file/<fileId>?layer_id=<pageId>',
    },
    {
      type: 'iconfont',
      url: 'https://at.alicdn.com/t/c/font_123456_abcdef.js',
    },
    {
      type: 'jsdesign',
      dir: './jsdesign-svg',
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

Figma supports OAuth with automatic renewal: configure your app, run `iconctl auth figma login`, and `sync` / `preview` refresh tokens as needed. See the [OAuth setup guide](apps/website/figma.md). Local credentials stay outside the repository; CI uses an independent authorization and three OAuth Secrets. Personal tokens via `FIGMA_TOKEN` remain supported with manual renewal; MasterGo uses `MASTERGO_TOKEN`. Directory, iconfont Symbol URLs, and 即时设计 export folders need no token. MasterGo requires Team edition and a team-project file. 即时设计 has no public REST for CLI — export SVG first.

## GitHub Action

```yaml
- uses: icelib/iconctl@v1
  with:
    figma-client-id: ${{ secrets.FIGMA_CLIENT_ID }}
    figma-client-secret: ${{ secrets.FIGMA_CLIENT_SECRET }}
    figma-refresh-token: ${{ secrets.FIGMA_REFRESH_TOKEN }}
    mastergo-token: ${{ secrets.MASTERGO_TOKEN }}
    commit: true
```

## License

MIT

OAuth workflows must serialize jobs sharing an authorization with a fixed concurrency group and `cancel-in-progress: false`. See [github-publish.yml](examples/github-publish.yml).
