# Distribute

`iconctl` publishes the **tool**. Product icons are generated in *your* repo, then developers consume them in one of two ways. Designer [Publish](/publish) only opens a PR. The split is what happens after merge.

## 1. JSON in the app repo

Merge the PR. `git pull`. No npm.

```ts
output: {
  json: 'src/icons.json',
  types: 'src/icon-names.ts',
  preview: 'preview.html',
  changelog: 'CHANGELOG.md',
}
```

Worked example: [`examples/app-json`](https://github.com/icelib/iconctl/tree/main/examples/app-json). This site’s [demo gallery](/demo) is the same pattern.

Tailwind (`@iconify/tailwind4`):

```ts
import { addDynamicIconSelectors } from '@iconify/tailwind4'
import icons from './src/icons.json'

addDynamicIconSelectors({
  prefix: 'i',
  iconSets: { brand: icons },
})
```

UnoCSS:

```ts
import icons from './src/icons.json'
import { defineConfig, presetIcons } from 'unocss'

export default defineConfig({
  presets: [
    presetIcons({
      collections: { brand: icons },
    }),
  ],
})
```

Class: `i-brand-arrow-left`. See [Icon formats](/formats).

## 2. Installable package

Merge the PR, version, publish. Other apps install it.

### Iconify JSON package

```ts
output: {
  jsonPackage: {
    dir: 'packages/icon-json',
    name: '@iconify-json/brand', // default `@iconify-json/${prefix}`
  },
}
```

```bash
pnpm add @iconify-json/brand
```

```ts
import icons from '@iconify-json/brand/icons.json'
```

Same `iconSets` / `collections` wiring as above. `clean: false` keeps sibling files (README, changelog) in that directory.

### Workspace / npm package with preview

`packages/icons` (`@iconctl/icons`) is this repo’s example: JSON + types + `preview.html` + `CHANGELOG.md`. After publish:

```bash
pnpm add @iconctl/icons
```

```ts
import icons from '@iconctl/icons'
```

Class: `i-ice-arrow-left`.

In a changesets monorepo, the icon sync PR should include a patch changeset so release can publish. This repo’s `.github/workflows/iconctl.yml` does that. GitHub Packages is the same package with a different `publishConfig.registry`.

## GitHub Action

```yaml
- uses: icelib/iconctl@v1
  with:
    token: ${{ secrets.FIGMA_TOKEN }}
    pr: true
```

`examples/github-publish.yml` is the copy-paste workflow. `paths` limits `git add`. `changeset: true` writes a patch changeset when icons change.

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
