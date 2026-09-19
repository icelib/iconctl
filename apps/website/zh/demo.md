# 演示

这是 **`@iconctl/icons`**，本仓库发布的图标包。源在 `packages/icons/raw`。`iconctl sync` 会写出 Iconify JSON、SVG、类型、`preview.html`，以及按增删改记的 `CHANGELOG.md`。

点图标复制 `i-iconctl-arrow-left`。改颜色可以确认 fill 已经洗成 `currentColor`。

<IconDemoGallery />

## 从 iconfont 添加

公开的 Symbol CDN，不用 token。脚本写入 `raw/`，再 sync：

```bash
pnpm --filter @iconctl/icons add-iconfont -- https://at.alicdn.com/t/c/font_xxx.js
```

`--only arrow-left,user` 只收一部分。默认去掉 `icon-` 前缀。把 package 文件提交上去，下次文档部署就会出现在这页。

改或删 `raw/` 里的 SVG，再跑 `pnpm --filter @iconctl/icons sync`，changelog 同样会记。

Actions → **iconctl publish** → Run workflow 也可以填同一个 Symbol URL。

## 变更记录

<IconChangelog />
