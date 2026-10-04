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
| `iconctl init` | 通过向导或显式参数创建新配置 |
| `iconctl sync` | 加载来源、清洗、校验、导出 |
| `iconctl watch` | 持续同步本地 SVG 目录，自动重载配置 |
| `iconctl check` | 校验配置产物或 `--input icons.json` |
| `iconctl preview` | 从配置或 `--input icons.json` 生成可离线搜索的画廊 |
| `iconctl diff <before> <after>` | 比较本地 Iconify JSON，可生成离线 HTML 差异报告 |

在脚本中显式指定来源、位置和前缀：

```bash
pnpm exec iconctl init --source directory --input ./raw-svg --prefix brand --no-interactive --json
```

`init` 创建新的 `iconctl.config.ts`，已有目标不会被覆盖。用 `--config ./config/brand.config.ts` 选择其他 `.ts` 目标，用 `--json-output ./generated/icons.json` 设置生成集合的路径。`--json` 禁用提示并返回一个结果对象；`--dry-run` 只验证，不写入任何文件或目录。初始化只创建配置，鉴权与 `sync` 需分别执行。配置位于子目录时，相对路径仍以当前目录为基准。六种来源、iconfont `--url`、必填参数和取消行为详见[脚本化初始化](apps/website/zh/quick-start.md#脚本化初始化)。

`preview.html` 可离线搜索完整 Iconify 名称或工具类，并复制 `brand:arrow-left` 或 `i-brand-arrow-left`。剪贴板受限时会提供可选择的文本供手动复制；禁用 JavaScript 后仍展示全部图标。类名快捷复制要求前缀和名称均由小写字母、数字和分隔它们的单个连字符组成，且使用方已配置图标工具。不带 `--input` 的 `iconctl preview` 会运行 sync，生成时可能访问配置的来源。

浏览已有集合可运行 `iconctl preview --input ./icons.json --output ./reports/preview.html`。此模式只使用本地文件，不执行配置，保留来源文件内容；默认输出到当前目录的 `preview.html`。本地模式的 `--dry-run --json` 只验证，不创建文件、目录或缓存。详见[本地预览](apps/website/zh/quick-start.md#预览本地集合)。

`sync --json` 输出 `added`、`removed`、`changed`、`skipped`、`sources`、`fileVersion`、`outputFiles`。校验失败默认非 0 退出，并且不写半成品。

`sync({ signal })` 支持调用方取消。单项导入／处理失败现在也会默认阻止产物替换。显式设置 `continueOnError: true` 可导出成功项，结果带有 `complete: false`、诊断 `issues` 和 `diff.deletionsReliable: false`，不报告删除、不更新 changelog。产物先暂存再提交：提交前取消保留旧产物，提交开始后取消会等待提交成功；共享 OAuth 刷新安全结束后才返回取消。不保证跨路径原子发布，完整契约见[同步完整性与取消](apps/website/zh/quick-start.md#同步完整性与取消)。

本地开发可运行 `iconctl watch`：启动时同步一次，随后监听 SVG 变更。请将 `raw-svg` 等输入与生成的 SVG／包目录分开。支持 `directory`、`jsdesign.dir`、`iconfont.dir` 和 `iconify.file` 本地来源；远程来源继续使用 `sync`。`watch --json` 输出 NDJSON 事件。配置恢复、取消和 API 详见[本地监听](apps/website/zh/quick-start.md#本地监听)。

可选配置 `output.sprite: 'icons.svg'` 会在 Iconify JSON 之外生成一份 SVG symbol 集合。使用 `<use href="/icons.svg#iconctl-brand-home">` 引用图标；symbol ID 稳定，别名保留对应变换。内联用法、无障碍标注及支持的静态 SVG 格式详见 [SVG sprite](apps/website/zh/quick-start.md#svg-sprite)。

本地 Iconify JSON 可以与 SVG 或远程来源混用：`{ type: 'iconify', file: './vendor/icons.json', include: ['home'], namePrefix: 'vendor-' }`。别名、旋转和继承尺寸会先解析，再进入已有处理流程。详见 [Iconify JSON 来源](apps/website/zh/sources.md#本地-iconify-json)。

独立校验一个集合可运行 `iconctl check --input ./icons.json --width 24 --height 24 --json`，不加载配置、不请求来源、不写文件。尺寸规则可省略，`--name` 可覆盖命名正则。失败报告汇总导入、SVG 处理及校验问题，并以状态码 1 退出。详见[校验已有产物](apps/website/zh/quick-start.md#校验已有产物)。

运行 `iconctl diff before.json after.json --html diff.html` 可审核两份导出集合，比较时解析别名、继承尺寸和变换，并单独报告前缀变化，无需配置或凭据。CI 可加 `--check --json`；图标或前缀存在变化时 `--check` 以 1 退出。报告、dry-run 和 API 详见[离线比较](apps/website/zh/quick-start.md#离线比较)。

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
    sprite: 'icons.svg', // 可选的 SVG symbol 集合
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

控制台项目可以从任务固定的仓库提交导入 Iconify JSON 文件，按精确名称选择图标／别名，并原样添加名称前缀。参阅[仓库 Iconify JSON](apps/website/zh/console.md#仓库-iconify-json)。
