# 发布

设计师画完图标，在 Figma 插件里点 **Publish**，工程侧就会收到带 Iconify JSON 的 PR。

```
Figma 插件（预检）→ GitHub repository_dispatch
  → iconctl sync（Actions 里的 FIGMA_TOKEN）
  → PR：icons.json + preview.html
  → 开发 review 后合并
```

Figma 的 Publish Library 仍然是给**其他设计稿**用的。这个按钮是给**代码**的。文件保存即可（自动保存就行），Action 走 REST 读文件。

## 工程侧（只需一次）

1. 业务仓里的 `iconctl.config.ts`，Figma 源指向图标 Library。
2. 把 `examples/github-publish.yml` 拷到 `.github/workflows/iconctl.yml`。
3. 仓库密钥 `FIGMA_TOKEN`：能**读**该 Library 的 token。
4. workflow 权限：`contents: write`、`pull-requests: write`。

## 设计师（只需一次）

1. `pnpm --filter @iconctl/figma-plugin build`
2. Figma → Plugins → Development → Import plugin from manifest → `packages/figma-plugin/manifest.json`
3. 插件设置：
   - GitHub 仓库 `owner/name`
   - 只对该仓库有 **Actions: write** 的 fine-grained PAT（不是 `FIGMA_TOKEN`）
   - Event 类型 `iconctl-publish`

## 每次发版

1. 组件名 `arrow-left`，24×24，草稿 `_…`
2. 在图标页打开插件，把标红的改掉
3. Publish
4. 打开插件给出的 Actions 链接；workflow 会开 `chore: sync icons`

不要把 `contents:write` 的 PAT 放进插件。写 JSON 的是 Action，不是插件。

merge 之后，开发要么 **git pull**（JSON 在应用仓），要么 **`pnpm add`**（已发布的包）。两种都在[分发](/zh/distribute)。

## 这个仓库

`packages/icons`（`@iconctl/icons`）是完整示例。源是 `raw/` 里的本地 SVG，也可以加 iconfont Symbol URL。sync 会写出 `icons.json`、`svg/`、`src/icon-names.ts`、`preview.html` 和 `CHANGELOG.md`。[演示](/zh/demo)页会预览这个包和 changelog。

```bash
pnpm --filter @iconctl/icons sync
pnpm --filter @iconctl/icons add-iconfont -- https://at.alicdn.com/t/c/font_xxx.js
```

`.github/workflows/iconctl.yml` 监听 `iconctl-publish` 和 `workflow_dispatch`，然后只把 `packages/icons` 开成 PR。`workflow_dispatch` 可以带 iconfont URL。Figma 插件可以指向 `icelib/iconctl` 走同一条 event（workflow 仍然不会请求 Figma）。

## 私有线上控制台

需要在网页管理多项目、授权续期、快照审核和 npm 发布时，参阅[控制台接入](./console)。
