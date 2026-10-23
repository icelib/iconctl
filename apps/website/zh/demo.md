# 演示

这个画廊使用 **`@iconctl/icons`**，供本站通过 workspace 本地引用的私有示例包。源在 `packages/icons/raw`。`iconctl sync` 会写出 Iconify JSON、SVG、类型、`preview.html`，以及按增删改记的 `CHANGELOG.md`。该示例不参与 npm 正式版和 nightly 发布。

点图标复制 `i-ice-arrow-left`。改颜色可以确认 fill 已经洗成 `currentColor`。

<IconDemoGallery />

## 从 iconfont 添加

公开的 Symbol CDN，不用 token。脚本写入 `raw/`，再 sync：

```bash
pnpm --filter @iconctl/icons add-iconfont -- https://at.alicdn.com/t/c/font_xxx.js
```

`--only arrow-left,user` 只收一部分。默认去掉 `icon-` 前缀。提交生成文件并合并 PR 后，文档预览站会更新；正式站随下一次 `@iconctl/core` 或 `iconctl` 稳定版本，部署包含该示例的完整冻结源码快照。

改或删 `raw/` 里的 SVG，再跑 `pnpm --filter @iconctl/icons sync`，changelog 同样会记。

在 Actions 中手动运行图标同步工作流（`.github/workflows/iconctl.yml`），也可以填写同一个 Symbol URL。该流程只创建 PR，不生成发布意图。

## 变更记录

<IconChangelog />
