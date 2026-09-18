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

`iconSets` / `collections` 接法和上面一样。`clean: false` 会保留同目录里的 README、changelog。

### 带预览的 workspace / npm 包

`packages/icons`（`@iconctl/icons`）是本仓库的例子：JSON + 类型 + `preview.html` + `CHANGELOG.md`。发布后：

```bash
pnpm add @iconctl/icons
```

```ts
import icons from '@iconctl/icons'
```

class：`i-iconctl-arrow-left`。

用 changesets 的 monorepo 里，图标 PR 应带一个 patch changeset，release 才能发版。本仓库的 `.github/workflows/iconctl.yml` 会写这个 changeset。GitHub Packages 只是换 `publishConfig.registry`。

## GitHub Action

```yaml
- uses: icelib/iconctl@v1
  with:
    token: ${{ secrets.FIGMA_TOKEN }}
    pr: true
```

`examples/github-publish.yml` 可直接拷。`paths` 限制 `git add`。`changeset: true` 在图标有 diff 时写 patch changeset。

## 命令

| 命令 | 作用 |
| --- | --- |
| `iconctl init` | 写 `iconctl.config.ts` |
| `iconctl sync` | 加载来源、清洗、校验、导出 |
| `iconctl check` | 校验已有 SVG/JSON |
| `iconctl preview` | 写 `preview.html` |

库 API：

```ts
import { defineConfig, loadConfig, sync } from 'iconctl'
```
