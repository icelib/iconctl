# 快速开始

## 1. 安装

```bash
pnpm add -D iconctl
```

## 2. 写配置

```bash
pnpm exec iconctl init
```

或手写 `iconctl.config.ts`：

```ts
import { defineConfig } from 'iconctl'

export default defineConfig({
  prefix: 'brand',
  sources: [
    {
      type: 'figma',
      file: 'https://www.figma.com/design/<fileKey>/Icons',
      pages: ['Icons'],
    },
  ],
  output: {
    json: 'icons.json',
    svg: 'svg',
    preview: 'preview.html',
  },
  validate: {
    width: 24,
    height: 24,
  },
})
```

本地目录不需要 token，产出同一份 Iconify JSON：

```ts
sources: [{ type: 'directory', dir: './raw-svg' }]
```

## 3. Token

Figma 推荐使用 [OAuth 登录与自动续期](/zh/figma#oauth-登录与自动续期)。完成 App 配置后运行 `pnpm exec iconctl auth figma login`，后续同步自动刷新令牌。目录来源不需要凭据。

也可以使用需手动更换的个人令牌：

```bash
export FIGMA_TOKEN=figu_xxx
```

## 4. 同步

```bash
pnpm exec iconctl sync
```

CI：

```bash
pnpm exec iconctl sync --json
```

`--dry-run` 不写图标产物，但可能更新认证凭据和缓存。图标导入、加工或校验失败时，默认非 0 退出并保留原有产物。错误会指出受影响的图标，包括 Figma 缺少导出链接、SVG 下载失败等情况。

明确允许部分产物时，使用 `pnpm exec iconctl sync --continue`。命令成功退出，并通过警告列出跳过的图标和校验问题。搭配 `--json` 时，检查原有的 `skipped`、`issues` 字段即可判断是否为部分结果。认证失败、来源不可读取仍会终止命令。

部分同步不会把当前 Figma 版本标记为已完成。修复来源或网络后，再运行 `sync` 即会重试失败的图标。无效 SVG 响应、不完整的图片导出响应不会从下载缓存复用。

所有配置的产物会先准备好，再替换现有文件；生成或替换失败时触发回滚。若回滚未能完成，错误会给出保留的恢复文件位置。提交完成后若临时目录清理失败，会通过 `ICONCTL_OUTPUT_CLEANUP` 警告报告残留目录，同步仍视为成功。输出路径不能重复或相互包含：例如，把 `icons.json` 放在 SVG 目录旁边，而不是目录内部。JSON 包目录、预览、类型、变更日志和缓存元数据也遵循这一规则。

SVG 输出目录中的 `.iconctl-manifest.json` 记录生成的 SVG。后续同步据此删除过期产物，并保留无关文件。升级后首次清理旧 SVG 时，只有内容与上一份 Iconify JSON 完全一致的文件才被视作旧产物。无法确认归属的旧文件会保留；本次生成的同名文件仍会更新。请随 SVG 输出目录一起保留该清单。

## 5. 使用 JSON

在 `@iconify/tailwind4` 或 UnoCSS 里把自定义 collection 指到 `icons.json`，然后写 `i-brand-arrow-left`。这个 class 是 CSS mask，不是字体。

给别的开发两种拿法：JSON **跟应用仓一起走**，或发成 **可安装的包**。见[分发](/zh/distribute)。

## 私有线上控制台

需要在网页管理多项目、授权续期、快照审核和 npm 发布时，参阅[控制台接入](./console)。
