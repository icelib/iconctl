# 分发

`figma-iconify` 发的是**工具**。业务图标生成在你们自己的仓库里。

## 1. 业务仓里的 JSON

```ts
output: { json: 'src/icons.json' }
```

UnoCSS / Tailwind 指向这个文件，跟应用一起发布。

## 2. Iconify JSON 包

```ts
output: {
  jsonPackage: 'packages/icons',
}
```

布局与 `@iconify-json/<prefix>` 一致。把这个包发到 npm，所有应用依赖它。

## 3. GitHub Action

```yaml
- uses: sonofmagic/figma-iconify@v1
  with:
    token: ${{ secrets.FIGMA_TOKEN }}
    commit: true
```

Action 内部跑 `figma-iconify sync --json`。Figma 文件没改时退出 0，不写文件。

## 命令

| 命令 | 作用 |
| --- | --- |
| `figma-iconify init` | 写 `figma-iconify.config.ts` |
| `figma-iconify sync` | 拉取、清洗、校验、导出 |
| `figma-iconify check` | 校验已有 SVG/JSON，不打 Figma |
| `figma-iconify preview` | 写 `preview.html` |

库 API：

```ts
import { defineConfig, sync, loadConfig } from 'figma-iconify'
```
