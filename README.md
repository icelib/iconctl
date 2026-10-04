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
| `iconctl init` | Create a new config interactively or from explicit options |
| `iconctl sync` | Load sources, clean, validate, export |
| `iconctl watch` | Continuously sync local SVG folders and reload config |
| `iconctl check` | Validate configured output or `--input icons.json` |
| `iconctl preview` | Write a searchable offline gallery from config or `--input icons.json` |
| `iconctl diff <before> <after>` | Compare local Iconify JSON and optionally write an offline HTML report |

For scripts, provide a source, location and prefix:

```bash
pnpm exec iconctl init --source directory --input ./raw-svg --prefix brand --no-interactive --json
```

`init` creates a new `iconctl.config.ts` without overwriting an existing target. Use `--config ./config/brand.config.ts` for another `.ts` target and `--json-output ./generated/icons.json` to set the generated collection path. `--json` disables prompts and returns one result object; `--dry-run` validates without writing any files or directories. Initialization only creates the config; run authentication and `sync` separately. Relative paths still use the current directory when the config is nested. See [scriptable initialization](apps/website/quick-start.md#scriptable-initialization) for all six sources, iconfont `--url`, required options and cancellation.

`preview.html` works offline: search full Iconify names or utility classes, then copy `brand:arrow-left` or `i-brand-arrow-left`. Clipboard restrictions show a selectable manual-copy fallback. All icons remain visible when JavaScript is disabled. Class shortcuts require lowercase letters/digits separated by single hyphens in both prefix and name, and a configured icon utility consumer. Without `--input`, `iconctl preview` runs sync and can contact your configured sources.

To browse an existing collection, run `iconctl preview --input ./icons.json --output ./reports/preview.html`. This uses only local files, executes no config, and preserves source bytes. The default output is `preview.html` in the current directory. Local `--dry-run --json` validates without creating files, directories or caches. See [local preview](apps/website/quick-start.md#preview-a-local-collection).

`sync --json` prints `added`, `removed`, `changed`, `skipped`, `sources`, `fileVersion`, and `outputFiles`. Validation failures exit non-zero and do not write a partial set.

`sync({ signal })` supports caller cancellation. Individual import/processing failures now also block output replacement by default. Explicit `continueOnError: true` exports available icons with `complete: false`, diagnostic `issues`, and `diff.deletionsReliable: false`; removals and changelog updates are suppressed. Outputs are staged before commit. Cancellation before commit preserves old outputs; cancellation after commit starts waits for successful completion. Shared OAuth refresh finishes safely before cancellation returns. Cross-path atomic publication is not guaranteed; see [cancellation and integrity](apps/website/quick-start.md#sync-integrity-and-cancellation) for the full contract.

For local development, `iconctl watch` performs an initial sync and watches SVG edits. Keep inputs such as `raw-svg` separate from generated SVG/package directories. It supports local `directory`, `jsdesign.dir`, `iconfont.dir` and `iconify.file` sources; remote sources still use `sync`. `watch --json` emits NDJSON events. See [local watch](apps/website/quick-start.md#local-watch) for configuration recovery, cancellation and the API.

Add optional `output.sprite: 'icons.svg'` to export one SVG symbol collection alongside Iconify JSON. Reference an icon with `<use href="/icons.svg#iconctl-brand-home">`; symbol IDs are stable and aliases retain their transforms. For an existing local collection, run `iconctl sprite --input collection.json --output icons.svg` without config or credentials. See [SVG sprites](apps/website/quick-start.md#svg-sprites) for inline use, accessibility and the supported static SVG format.

Local Iconify JSON can be mixed with SVG or remote sources: `{ type: 'iconify', file: './vendor/icons.json', include: ['home'], namePrefix: 'vendor-' }`. Aliases, rotations and inherited dimensions are resolved before the usual processing. See [Iconify JSON sources](apps/website/sources.md#local-iconify-json).

To check a standalone collection, run `iconctl check --input ./icons.json --width 24 --height 24 --json`. This does not load configuration, contact sources or write files. Dimensions are optional; `--name` overrides the naming regex. Failure reports include import, SVG processing and validation issues and exit with status 1. See [artifact checks](apps/website/quick-start.md#check-existing-artifacts).

Review two exported collections with `iconctl diff before.json after.json --html diff.html`. It resolves aliases, inherited dimensions and transforms, reports prefix changes, and needs no configuration or credentials. Add `--check --json` for CI; `--check` exits 1 when icons or their prefix differ. See [offline comparison](apps/website/quick-start.md#offline-comparison) for the report, dry-run and API.

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
    sprite: 'icons.svg', // Optional SVG symbol sprite
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

## Private console

The owner-only Vue/Hono console lives at `/app` alongside the public documentation. See [setup, GitHub App, OAuth and deployment](apps/website/console.md).

Console projects can import an Iconify JSON file from each task's pinned repository commit or a local upload of up to 10 MiB, select original icon/alias names and add a literal name prefix. Uploads take effect after saving the project and remain fixed to each task. See [repository or uploaded Iconify JSON](apps/website/console.md#repository-iconify-json).
