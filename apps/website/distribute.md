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

`output.types` exports the literal `ICONIFY_PREFIX` and an `IconName` union, including resolved aliases. Use a `.ts` path when your app imports the prefix at runtime. A `.d.ts` path provides declarations for type checking only; it does not create a JavaScript module. Empty collections produce `IconName = never`.

For an existing collection, `iconctl types --input ./icons.json` generates these types directly. See [local type generation](./quick-start#generate-types-from-local-json).

Open the generated `preview.html` directly to browse offline. Search matches full Iconify names and available utility classes as case-insensitive, literal text; clearing the search restores every icon, including aliases. Copy buttons provide `brand:arrow-left` and `i-brand-arrow-left`. The latter follows the configured icon utility convention below and is offered only when both prefix and name contain lowercase letters/digits separated by single hyphens. Other names remain visible and copyable as full Iconify names.

When the browser denies clipboard access or does not provide it for a local file, the gallery shows selectable text for manual copying. Without JavaScript, all icons and names remain visible. The generated file needs no server or network. Generate it entirely from local files with `iconctl preview --input ./icons.json --output ./preview.html`; this does not execute configuration or update caches. Without `--input`, `iconctl preview` runs sync and can contact configured sources while generating it.

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

Same `iconSets` / `collections` wiring as above. `clean: false` keeps sibling files (README, changelog) and custom `package.json` fields. Generated entry points and explicitly configured `jsonPackage.package` values take precedence over existing fields.

### Private workspace demo and your own npm package

`packages/icons` (`@iconctl/icons`) is this repository's private workspace demo: JSON + types + `preview.html` + `CHANGELOG.md`. The website consumes it through `workspace:*`. The sync workflow opens a PR without release intent; merging updates the documentation preview. The formal site includes the demo in the complete frozen source snapshot of the next core or CLI stable release.

For your own installable icon package, use a name you control, such as `@acme/icons`. Configure its root export to expose `icons.json`, then version and publish it from your repository. Consumers can install and import your published package:

```bash
pnpm add @acme/icons
```

```ts
import icons from '@acme/icons'
```

With the `brand` prefix used above, the class is `i-brand-arrow-left`.

For a publishable package in a changesets monorepo, include a patch changeset in the icon sync PR so release can publish it. Private workspace demos do not need package release intent. GitHub Packages uses a different `publishConfig.registry`.

## GitHub Action

Complete [OAuth authorization](/figma#oauth-login-and-automatic-renewal) and configure the three Secrets. All jobs sharing a CI authorization must use the same concurrency group and run serially:

```yaml
concurrency:
  group: iconctl-figma-oauth
  cancel-in-progress: false
```

```yaml
- uses: icelib/iconctl@v1
  with:
    figma-client-id: ${{ secrets.FIGMA_CLIENT_ID }}
    figma-client-secret: ${{ secrets.FIGMA_CLIENT_SECRET }}
    figma-refresh-token: ${{ secrets.FIGMA_REFRESH_TOKEN }}
    pr: true
```

`examples/github-publish.yml` is the copy-paste workflow. `paths` limits `git add`. For your own publishable package, `changeset: true` writes a patch changeset when icons change.

Personal tokens remain supported through the `token` input using the `FIGMA_TOKEN` secret and take precedence over OAuth inputs, but require manual replacement. Use separate OAuth apps or accounts for CI and local development; never cache or upload credential files.

## Commands

| Command | Purpose |
| --- | --- |
| `iconctl auth figma login/status/logout` | Manage Figma OAuth authorization |
| `iconctl init` | Write `iconctl.config.ts` |
| `iconctl sync` | Load sources, clean, validate, export |
| `iconctl check` | Validate existing SVG/JSON |
| `iconctl preview` | Write a searchable offline gallery from config or `--input icons.json` |

Library API:

```ts
import { defineConfig, loadConfig, sync } from 'iconctl'
```
