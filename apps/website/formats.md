# Icon formats

iconctl writes **Iconify JSON** (and optional SVG files). That is the engineering source. How each app *paints* an icon is a separate choice. `i-brand-arrow-left` is a CSS class, usually a mask — not a font.

## Catalog

Every paint scheme that has shown up in this product. **Mainstream** here means what new Web / mini-program UI actually ships in the 2020s, not what iconfont.cn still generates.

| Scheme | Status | Job |
| --- | --- | --- |
| [CSS mask](#css-mask) | Mainstream | Product UI + mini programs. iconctl default. |
| [Inline SVG](#inline-svg) | Mainstream | Vue/React components, animation, a11y. |
| [Iconify runtime](#iconify-runtime) | Mainstream | Public sets / apps that already have `@iconify/vue`. |
| [SVG file](#svg-file) | Situational | Illustrations, logos, `<img>`. |
| [CSS background](#css-background) | Situational | Multi-color icon as a CSS class. |
| [Symbol sprite](#symbol-sprite) | Legacy | `<use>` / iconfont Symbol JS. Still common in CN. |
| [Webfont](#webfont) | Legacy | `@font-face` + PUA. Still common in CN. |

iconctl **does not** emit webfonts or symbol JS. iconfont Symbol URLs are an [input](/sources). PNG / native iOS/Android vectors are out of scope.

<IconFormatToolbar />

## CSS mask

**Mainstream.** `mask-image` plus `background-color: currentColor`. Same class API as iconfont (`i-brand-arrow-left`), no font metrics, tree-shaken by UnoCSS or `@iconify/tailwind4`. Monochrome only. This is the [mini program](/miniprogram) recipe and iconctl’s Web default.

<IconFormatDemo scheme="mask" />

## Inline SVG

**Mainstream** in component apps. Put `<svg>` in HTML or a Vue/React SFC — same paint. Full CSS, animation, `aria` / `title`. Repeating the same icon in markup is heavy. Mini programs do not consume SVG the way a browser does. The [demo](/demo) gallery inlines JSON `body` for preview; that is not the production class API.

<IconFormatDemo scheme="inline" />

## Iconify runtime

**Mainstream** for public collections and apps that already run `@iconify/vue` (or the web component). JSON in, inline SVG out. Extra JS. Not a mini-program option. iconctl’s Web default still prefers build-time CSS.

<IconFormatDemo scheme="runtime" />

## SVG file

**Situational.** `<img src="arrow-left.svg">`. Easy to cache. Color is baked in, so it will not follow `text-primary`. Mini programs often reject or rasterize SVG `<image>`. Use for illustrations and logos, not for a 24px UI set.

<IconFormatDemo scheme="file" />

## CSS background

**Situational.** `background-image` data-URI or file, no mask. Multi-color survives; `currentColor` does not. Use when the asset is inherently multi-color and you still want a CSS class.

<IconFormatDemo scheme="background" />

## Symbol sprite

**Legacy**, still common in Chinese iconfont workflows. One file of `<symbol id>`, then `<svg><use href="#id"></use></svg>`. iconfont “Symbol” is this plus a JS injector. `currentColor` works on the host SVG. External sprites hit CORS; the whole set downloads unless you regenerate per app. `<use>` is generally missing in WeChat / Alipay / Douyin. iconctl will not write this.

<IconFormatDemo scheme="symbol" />

## Webfont

**Legacy**, still common via iconfont.cn. `@font-face` plus a Private Use Area glyph. Tiny HTML, familiar. Whole font ships, FOUT, baseline drift, PUA is not real text. The glyphs below are a **demo font only** (stroke icons collapsed to fills) — not an iconctl output. Do not generate a webfont from this pipeline. If you already have a Symbol CDN, [ingest it](/sources) and leave the font behind.

<IconFormatDemo scheme="webfont" />

<IconFormatScores />

## Extra: the four names people say

People often say “SVG / webfont / symbol / CSS mask”. Those four mix file format, transport, and paint method:

| People say | What they usually mean |
| --- | --- |
| SVG | Inline `<svg>`, `<img src="*.svg">`, or CSS `background-image` |
| Symbol | SVG sprite `<symbol>` + `<use>`, or iconfont.cn Symbol JS |
| CSS mask | `mask-image` + `background-color: currentColor` |
| Webfont | `@font-face` + PUA glyph |

The catalog above is the split this product actually uses.
