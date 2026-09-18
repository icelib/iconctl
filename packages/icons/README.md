# @iconctl/icons

Installable icon set for the [publish flow](../../apps/website/publish.md) (mode 2). Source is local SVG (`raw/`), Lucide icons (ISC). Sync writes JSON, SVG, types, `preview.html`, and `CHANGELOG.md`.

```bash
pnpm add @iconctl/icons
```

```ts
import icons from '@iconctl/icons'
```

Point UnoCSS / Tailwind `collections` / `iconSets` at that JSON. Class: `i-iconctl-arrow-left`. Types: `@iconctl/icons/names`.

Same repo:

```bash
pnpm --filter @iconctl/icons sync
```

Open `preview.html`. The `iconctl-publish` workflow opens a PR and a patch changeset so merge can publish this package.
