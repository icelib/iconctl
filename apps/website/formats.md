# Icon formats

iconctl writes **Iconify JSON** (and optional SVG files). That is the engineering source. How each app *paints* an icon is a separate choice.

`i-brand-arrow-left` is a CSS class, usually a mask, not a font and not a new file format.

## Are SVG / webfont / symbol / CSS mask the whole map?

No. Those four names mix file format, transport, and paint method:

| People say | What they usually mean |
| --- | --- |
| SVG | Inline `<svg>`, `<img src="*.svg">`, or CSS `background-image` |
| Symbol | SVG sprite `<symbol>` + `<use>`, or iconfont.cn “Symbol” JS |
| CSS mask | `mask-image` + `background-color: currentColor` |
| Webfont | `@font-face` + Private Use Area glyph (classic iconfont) |

A complete map for Web and mini programs in this product:

1. Inline SVG (including Vue/React SVG components)
2. SVG file (`<img>` or `background-image`)
3. SVG symbol sprite (`<use href="#id">`, iconfont Symbol JS)
4. CSS mask (UnoCSS, `@iconify/tailwind4`, weapp-tailwindcss)
5. CSS background data-URI without mask (color baked in)
6. Iconify runtime (`@iconify/vue`, web component) — JSON in, inline SVG out
7. Webfont / iconfont

Native iOS/Android vectors, PNG/PDF, and canvas are out of scope here. Multicolor brand marks stay images, not Iconify icons.

iconctl **does not** emit webfonts or symbol JS. iconfont Symbol URLs are an [input](/sources), not an output.

## Comparison

| Scheme | `currentColor` | Multi-color | Tree-shake | Extra request | Mini program |
| --- | --- | --- | --- | --- | --- |
| Inline SVG | Yes | Yes | Per component | No, if bundled | Poor SVG support |
| SVG file | No | Yes | Unused files | One per file | Often PNG instead |
| Symbol sprite | Yes | Awkward | Weak unless rebuilt | One sprite / JS | `<use>` missing |
| CSS mask | Yes | No | Yes (Uno/Tailwind) | No, if CSS bundled | **Recommended** |
| CSS background | No | Yes | Yes | In CSS | Possible |
| Iconify runtime | Yes | Yes | On demand | Runtime JS | No |
| Webfont | As text | No | Poor | Font file, FOUT | Painful |

### Inline SVG

Put `<svg>` in HTML or a Vue/React component. Full CSS, animation, and `aria`/`title`.

Cost: the same icon repeated in markup is heavy. Mini programs do not consume SVG the way a browser does.

The [demo](/demo) gallery inlines JSON `body` for preview. Production apps should not copy that pattern unless they already ship SVG components.

### SVG file

`<img src="arrow-left.svg">` or `background-image`. Easy to cache. Color is baked in, so it will not follow `text-primary`. Mini programs often reject or rasterize SVG `<image>`.

### Symbol sprite

One file of `<symbol id="...">`, then `<svg><use href="#arrow-left"></use></svg>`. iconfont’s “Symbol” mode is this plus a JS injector.

One cacheable blob, `currentColor` on the host SVG. External sprites hit CORS. The whole set downloads unless you regenerate per app. `<use>` is generally unavailable in WeChat / Alipay / Douyin. iconctl will not write this.

### CSS mask

`mask-image` (the SVG as alpha) plus `background-color: currentColor`. Class API like iconfont (`i-brand-arrow-left`), no font metrics, tree-shaken by UnoCSS or `@iconify/tailwind4`.

Monochrome only — a mask has no fills of its own. That matches iconctl’s `currentColor` pipeline. This is the [mini program](/miniprogram) recipe and the default Web path.

### CSS background without mask

Data-URI or file in `background-image` without a mask. Multi-color survives; `currentColor` does not. Use when the asset is inherently multi-color and you still want a CSS class.

### Iconify runtime

`@iconify/vue` (and friends) turn JSON into inline SVG at runtime. Useful for public collections and apps that already have that runtime. Extra JS. Not a mini-program option. iconctl’s Web default avoids this and emits CSS at build time.

### Webfont / iconfont

`@font-face` plus a PUA glyph. Tiny HTML, familiar. Whole font ships, FOUT/FOIT, baseline/alignment bugs, ligature collisions. PUA is not real text — screen readers fail easily. Mini-program font files are large and awkward.

Do not generate a webfont from this pipeline. If you already have an iconfont Symbol CDN, [ingest it](/sources) and leave the font behind.

## What to use

| Target | Renderer |
| --- | --- |
| Web (Vite / UnoCSS / Tailwind) | `@iconify/tailwind4` or UnoCSS → CSS mask, class `i-{prefix}-{name}` |
| Mini program | Same class names, CSS mask + `currentColor` |
| Multi-color logo | Image, not Iconify |
| Existing iconfont Symbol | `{ type: 'iconfont' }` as a source, then CSS mask |

Point the CSS tool at [distributed](/distribute) `icons.json`. One pipeline, one class namespace.
