# figma-iconify

从 Figma 文件拉取图标，清洗成 Iconify JSON，再发到所有已经会用 Iconify、UnoCSS 或 Tailwind 的系统。

Figma 只当设计源。Iconify JSON 当工程源。设计师继续画，前端不再收 zip，也不再维护 iconfont。

```bash
pnpm add -D figma-iconify
pnpm exec figma-iconify init
export FIGMA_TOKEN=figu_xxx
pnpm exec figma-iconify sync
```

消费：

```html
<span class="i-brand-arrow-left text-primary"></span>
```

## 产物

- `icons.json` — Iconify JSON
- `svg/` — 可选 SVG
- `@iconify-json/<prefix>` 风格包 — 可选
- `preview.html` — 设计和前端都能搜的画廊
- TypeScript `IconName` — 可选

## 下一步

- [快速开始](/zh/quick-start)
- [Figma 约定](/zh/figma)
- [分发](/zh/distribute)
- [小程序](/zh/miniprogram)
