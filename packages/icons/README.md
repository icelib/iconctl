# @iconctl/icons

Private workspace demo for this repository, excluded from npm stable and nightly publication. Source is `raw/` SVG. Sync writes JSON, SVG, types, `preview.html`, and `CHANGELOG.md`. The gallery and changelog also render on the [docs Demo](https://iconctl.icebreaker.top/demo) page.

Workspace consumers declare `"@iconctl/icons": "workspace:*"` and import the local package:

```ts
import icons from '@iconctl/icons'
```

Point UnoCSS / Tailwind `collections` / `iconSets` at that JSON. Class: `i-ice-arrow-left`. Types: `@iconctl/icons/names`.

Sync the demo within this repository:

```bash
pnpm --filter @iconctl/icons sync
pnpm --filter @iconctl/icons add-iconfont -- https://at.alicdn.com/t/c/font_xxx.js
```

`add-iconfont` writes into `raw/` then syncs. `--only arrow-left,user` takes a subset. The icon sync workflow (`.github/workflows/iconctl.yml`) opens a PR without release intent.

Merging updates the documentation preview. The formal website includes this demo from the complete frozen source snapshot of the next `@iconctl/core` or `iconctl` stable release.
