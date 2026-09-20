# @iconctl/icons

Installable icon set for this repo. Source is `raw/` SVG. Sync writes JSON, SVG, types, `preview.html`, and `CHANGELOG.md`. Preview and changelog also render on the [docs Demo](https://iconctl.icebreaker.top/demo) page.

```bash
pnpm add @iconctl/icons
```

```ts
import icons from '@iconctl/icons'
```

Point UnoCSS / Tailwind `collections` / `iconSets` at that JSON. Class: `i-ice-arrow-left`. Types: `@iconctl/icons/names`.

Same repo:

```bash
pnpm --filter @iconctl/icons sync
pnpm --filter @iconctl/icons add-iconfont -- https://at.alicdn.com/t/c/font_xxx.js
```

`add-iconfont` writes into `raw/` then syncs. `--only arrow-left,user` takes a subset. The `iconctl-publish` workflow opens a PR and a patch changeset so merge can publish this package.
