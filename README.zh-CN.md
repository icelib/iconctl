# iconctl

[English](README.md) | [简体中文](README.zh-CN.md)

从 Figma、本地 SVG 目录，以及以后更多设计平台拉取图标，清洗成 [Iconify](https://iconify.design/) JSON，再发到所有已经会用 Iconify、UnoCSS 或 Tailwind 的系统。

文档：https://iconctl.icebreaker.top

```bash
pnpm add -D iconctl
pnpm exec iconctl init
pnpm exec iconctl sync
```

```html
<span class="i-brand-arrow-left text-primary"></span>
```

工程源是 Iconify JSON。Figma 只是其中一种输入，不是产品本身。

## 包

| 包 | 作用 |
| --- | --- |
| [`iconctl`](apps/cli) | CLI + 公开 API |
| [`@iconctl/core`](packages/core) | 转换管线 |

## 命令

| 命令 | 作用 |
| --- | --- |
| `iconctl init` | 写 `iconctl.config.ts` |
| `iconctl sync` | 加载来源、清洗、校验、导出 |
| `iconctl check` | 校验已有产物，不打远程来源 |
| `iconctl preview` | 生成静态 HTML 画廊 |

`sync --json` 输出 `added`、`removed`、`changed`、`skipped`、`sources`、`fileVersion`、`outputFiles`。校验失败默认非 0 退出，并且不写半成品。

## 配置

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
    {
      type: 'directory',
      dir: './raw-svg',
    },
    {
      type: 'mastergo',
      file: 'https://mastergo.com/file/<fileId>?layer_id=<pageId>',
    },
    {
      type: 'iconfont',
      url: 'https://at.alicdn.com/t/c/font_123456_abcdef.js',
    },
    {
      type: 'jsdesign',
      dir: './jsdesign-svg',
    },
  ],
  output: {
    json: 'icons.json',
    svg: 'svg',
    jsonPackage: 'packages/icons',
    preview: 'preview.html',
  },
  validate: {
    width: 24,
    height: 24,
  },
})
```

Figma 支持 OAuth 自动续期：配置 App 后运行 `iconctl auth figma login`，后续 `sync` / `preview` 按需刷新。详见 [OAuth 配置指南](apps/website/zh/figma.md)。本地凭据保存在仓库外；CI 使用独立授权及三个 OAuth Secrets。`FIGMA_TOKEN` 个人令牌仍受支持，但需要手动更换；MasterGo 使用 `MASTERGO_TOKEN`。目录、iconfont Symbol URL、即时设计导出文件夹不需要 token。MasterGo 需要团队版和团队项目文件。即时设计没有给 CLI 用的公开 REST，先导出 SVG。

## GitHub Action

```yaml
- uses: icelib/iconctl@v1
  with:
    figma-client-id: ${{ secrets.FIGMA_CLIENT_ID }}
    figma-client-secret: ${{ secrets.FIGMA_CLIENT_SECRET }}
    figma-refresh-token: ${{ secrets.FIGMA_REFRESH_TOKEN }}
    mastergo-token: ${{ secrets.MASTERGO_TOKEN }}
    commit: true
```

## License

MIT

使用 OAuth 的 workflow 应设置固定 concurrency group 和 `cancel-in-progress: false`，使同一授权的任务串行执行。完整示例见 [github-publish.yml](examples/github-publish.yml)。

## 私有控制台

公开文档旁的 `/app` 提供仅所有者可用的 Vue/Hono 图标工作台。参阅[GitHub App、OAuth、插件与部署指南](apps/website/zh/console.md)。
