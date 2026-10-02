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
| `iconctl watch` | 持续同步本地 SVG 目录，自动重载配置 |
| `iconctl check` | 校验已有产物，不打远程来源 |
| `iconctl preview` | 生成静态 HTML 画廊 |

`sync --json` 输出 `added`、`removed`、`changed`、`skipped`、`sources`、`fileVersion`、`outputFiles`。校验失败默认非 0 退出，并且不写半成品。

`sync({ signal })` 支持调用方取消。单项导入／处理失败现在也会默认阻止产物替换。显式设置 `continueOnError: true` 可导出成功项，结果带有 `complete: false`、诊断 `issues` 和 `diff.deletionsReliable: false`，不报告删除、不更新 changelog。产物先暂存再提交：提交前取消保留旧产物，提交开始后取消会等待提交成功；共享 OAuth 刷新安全结束后才返回取消。不保证跨路径原子发布，完整契约见[同步完整性与取消](apps/website/zh/quick-start.md#同步完整性与取消)。

本地开发可运行 `iconctl watch`：启动时同步一次，随后监听 SVG 变更。请将 `raw-svg` 等输入与生成的 SVG／包目录分开。支持 `directory`、`jsdesign.dir`、`iconfont.dir` 和 `iconify.file` 本地来源；远程来源继续使用 `sync`。`watch --json` 输出 NDJSON 事件。配置恢复、取消和 API 详见[本地监听](apps/website/zh/quick-start.md#本地监听)。

本地 Iconify JSON 可以与 SVG 或远程来源混用：`{ type: 'iconify', file: './vendor/icons.json', include: ['home'], namePrefix: 'vendor-' }`。别名、旋转和继承尺寸会先解析，再进入已有处理流程。详见 [Iconify JSON 来源](apps/website/zh/sources.md#本地-iconify-json)。

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
