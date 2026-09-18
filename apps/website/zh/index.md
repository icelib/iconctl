# iconctl

从 Figma、本地 SVG 目录，以及以后更多设计平台拉取图标，清洗成 Iconify JSON，再发到所有已经会用 Iconify、UnoCSS 或 Tailwind 的系统。

```bash
pnpm add -D iconctl
pnpm exec iconctl init
pnpm exec iconctl sync
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
