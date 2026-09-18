# @iconctl/icons

Dogfood icon set for the [publish flow](../../apps/website/publish.md). Source is local SVG (`raw/`), Lucide icons (ISC). Sync writes JSON, SVG, types, `preview.html`, and `CHANGELOG.md`.

```bash
pnpm --filter @iconctl/icons sync
```

Open `preview.html`. In UnoCSS / Tailwind, point a collection at `icons.json` and use `i-iconctl-arrow-left`.

This package does **not** call Figma. The GitHub workflow still uses `iconctl-publish` so the Figma plugin can target `sonofmagic/iconctl` and exercise the same PR path.
