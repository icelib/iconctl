# 分发

`iconctl` 发的是**工具**。业务图标生成在你们自己的仓库里。

## 1. 业务仓里的 JSON

```ts
output: { json: 'src/icons.json' }
```

把 UnoCSS / Tailwind 指到这个文件，JSON 跟应用一起发。class 怎么画（CSS mask、内联 SVG、webfont）见[图标方案](/zh/formats)。

## 2. Iconify JSON 包

```ts
output: {
  jsonPackage: 'packages/icons',
}
```

## 3. GitHub Action

```yaml
- uses: sonofmagic/iconctl@v1
  with:
    token: ${{ secrets.FIGMA_TOKEN }}
    commit: true
```

Action 内部跑 `iconctl sync --json`。来源没改时退出 0，不写文件。

设计师点发布时开 PR，而不是推当前分支。见[发布](/zh/publish) 和 `examples/github-publish.yml`（`pr: true`）。

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
