# figma-iconify

Fetch icons from a Figma file, clean them into Iconify JSON, and publish them to every app that already speaks Iconify, UnoCSS, or Tailwind.

Figma stays the design source. Iconify JSON is the engineering source. Designers keep drawing; frontend never copies zip files or iconfont projects.

```bash
pnpm add -D figma-iconify
pnpm exec figma-iconify init
export FIGMA_TOKEN=figu_xxx
pnpm exec figma-iconify sync
```

Then consume the generated set:

```html
<span class="i-brand-arrow-left text-primary"></span>
```

## What it produces

- `icons.json` — Iconify JSON
- `svg/` — optional raw SVG
- `@iconify-json/<prefix>` style package — optional
- `preview.html` — a gallery both design and engineering can search
- TypeScript `IconName` — optional

## Next

- [Quick start](/quick-start)
- [Figma conventions](/figma)
- [Distribute](/distribute)
- [Mini programs](/miniprogram)
