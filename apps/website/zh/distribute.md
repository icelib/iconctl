# 分发

`iconctl` 发的是**工具**。业务图标生成在你们自己的仓库里，开发用下面两种方式之一去消费。设计师[发布](/zh/publish)只负责开 PR。分叉发生在 merge 之后。

## 1. 业务仓里的 JSON

merge PR，然后 `git pull`。不发 npm。

```ts
output: {
  json: 'src/icons.json',
  types: 'src/icon-names.ts',
  preview: 'preview.html',
  changelog: 'CHANGELOG.md',
}
```

`output.types` 导出字面量类型的 `ICONIFY_PREFIX` 和包含已解析别名的 `IconName` 联合类型。应用需要在运行时导入前缀时，使用 `.ts` 路径；`.d.ts` 只提供类型检查所需的声明，不会生成 JavaScript 模块。空集合生成 `IconName = never`。

已有集合可用 `iconctl types --input ./icons.json` 直接生成上述类型，详见[本地类型生成](./quick-start#从本地-json-生成类型)。

直接打开生成的 `preview.html` 即可离线浏览。搜索按完整 Iconify 名称和可用工具类做不区分大小写的字面量匹配；清空搜索后恢复全部图标和别名。复制按钮分别提供 `brand:arrow-left` 和 `i-brand-arrow-left`。后者遵循下方配置的图标工具约定，仅当前缀和名称均由小写字母、数字和分隔它们的单个连字符组成时提供；其他名称仍会展示，并可复制完整 Iconify 名称。

浏览器拒绝剪贴板访问，或本地文件没有剪贴板 API 时，画廊会显示可选择的文本供手动复制。禁用 JavaScript 后，全部图标和名称仍然可见。生成的文件无需服务器或网络。运行 `iconctl preview --input ./icons.json --output ./preview.html` 可完全从本地文件生成，不执行配置或更新缓存。不带 `--input` 的 `iconctl preview` 会运行 sync，生成时可能访问配置的来源。

完整示例：[`examples/app-json`](https://github.com/icelib/iconctl/tree/main/examples/app-json)。本站[演示画廊](/zh/demo)也是这种。

Tailwind（`@iconify/tailwind4`）：

```ts
import { addDynamicIconSelectors } from '@iconify/tailwind4'
import icons from './src/icons.json'

addDynamicIconSelectors({
  prefix: 'i',
  iconSets: { brand: icons },
})
```

UnoCSS：

```ts
import icons from './src/icons.json'
import { defineConfig, presetIcons } from 'unocss'

export default defineConfig({
  presets: [
    presetIcons({
      collections: { brand: icons },
    }),
  ],
})
```

class：`i-brand-arrow-left`。见[图标方案](/zh/formats)。

## 2. 可安装的包

merge PR，再发版。别的应用 `pnpm add`。

### Iconify JSON 包

```ts
output: {
  jsonPackage: {
    dir: 'packages/icon-json',
    name: '@iconify-json/brand', // 默认 `@iconify-json/${prefix}`
  },
}
```

```bash
pnpm add @iconify-json/brand
```

```ts
import icons from '@iconify-json/brand/icons.json'
```

`iconSets` / `collections` 接法和上面一样。`clean: false` 会保留同目录里的 README、changelog 和 `package.json` 自定义字段；生成的入口字段以及显式配置的 `jsonPackage.package` 值优先于已有字段。

### 带预览的 workspace / npm 包

`packages/icons`（`@iconctl/icons`）是本仓库的例子：JSON + 类型 + `preview.html` + `CHANGELOG.md`。发布后：

```bash
pnpm add @iconctl/icons
```

```ts
import icons from '@iconctl/icons'
```

class：`i-ice-arrow-left`。

用 changesets 的 monorepo 里，图标 PR 应带一个 patch changeset，release 才能发版。本仓库的 `.github/workflows/iconctl.yml` 会写这个 changeset。GitHub Packages 只是换 `publishConfig.registry`。

## GitHub Action

先完成 [OAuth 授权](/zh/figma#oauth-登录与自动续期)，设置三个 Secrets。同一 CI 授权的所有任务使用相同 concurrency group，且不要并行运行：

```yaml
concurrency:
  group: iconctl-figma-oauth
  cancel-in-progress: false
```

```yaml
- uses: icelib/iconctl@v1
  with:
    figma-client-id: ${{ secrets.FIGMA_CLIENT_ID }}
    figma-client-secret: ${{ secrets.FIGMA_CLIENT_SECRET }}
    figma-refresh-token: ${{ secrets.FIGMA_REFRESH_TOKEN }}
    pr: true
```

`examples/github-publish.yml` 可直接拷。`paths` 限制 `git add`。`changeset: true` 在图标有 diff 时写 patch changeset。

个人令牌仍可通过 `token` 输入使用 `FIGMA_TOKEN` Secret，优先于 OAuth 输入，但需要手动更换。CI 和本地使用独立 OAuth App 或账号；不要将凭据文件放入缓存或制品。

## 命令

| 命令 | 作用 |
| --- | --- |
| `iconctl auth figma login/status/logout` | 管理 Figma OAuth 授权 |
| `iconctl init` | 写 `iconctl.config.ts` |
| `iconctl sync` | 加载来源、清洗、校验、导出 |
| `iconctl check` | 校验已有 SVG/JSON |
| `iconctl preview` | 从配置或 `--input icons.json` 生成可离线搜索的画廊 |

库 API：

```ts
import { defineConfig, loadConfig, sync } from 'iconctl'
```
