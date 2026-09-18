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
