# iconctl

Load icons from Figma, a local SVG folder, or later other design tools. Clean them into Iconify JSON. Publish them to every app that already speaks Iconify, UnoCSS, or Tailwind.

```bash
pnpm add -D iconctl
pnpm exec iconctl init
pnpm exec iconctl sync
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
- [Publish](/publish)
- [Demo](/demo)
- [Other sources](/sources)
- [Distribute](/distribute)
- [Icon formats](/formats)
- [Mini programs](/miniprogram)
