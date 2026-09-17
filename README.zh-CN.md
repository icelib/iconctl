# figma-iconify

[English](README.md) | [简体中文](README.zh-CN.md)

从 Figma 拉取图标，清洗成 [Iconify](https://iconify.design/) JSON，再发到所有已经会用 Iconify、UnoCSS 或 Tailwind 的系统。

```bash
pnpm add -D figma-iconify
pnpm exec figma-iconify init
export FIGMA_TOKEN=figu_xxx
pnpm exec figma-iconify sync
```

```html
<span class="i-brand-arrow-left text-primary"></span>
```

Figma 只当设计源。Iconify JSON 当工程源。设计师继续在 Figma 里画，前端不再收 zip，也不再维护 iconfont。

## 包

| 包 | 作用 |
| --- | --- |
| [`figma-iconify`](apps/cli) | CLI + 公开 API |
| [`@icebreakers/figma-iconify`](packages/core) | 转换管线 |

## 命令

| 命令 | 作用 |
| --- | --- |
| `figma-iconify init` | 写 `figma-iconify.config.ts` |
| `figma-iconify sync` | 拉取、清洗、校验、导出 |
| `figma-iconify check` | 校验已有产物，不打 Figma |
| `figma-iconify preview` | 生成静态 HTML 画廊 |

`sync --json` 输出 `added`、`removed`、`changed`、`skipped`、`fileVersion`、`outputFiles`。校验失败默认非 0 退出，并且不写半成品。

## 配置

```ts
import { defineConfig } from 'figma-iconify'

export default defineConfig({
  file: 'https://www.figma.com/design/<fileKey>/Icons',
  prefix: 'brand',
  pages: ['Icons'],
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

Token 只走 `FIGMA_TOKEN`，不要写进配置文件。

## GitHub Action

```yaml
- uses: sonofmagic/figma-iconify@v1
  with:
    token: ${{ secrets.FIGMA_TOKEN }}
    commit: true
```

## Figma 约定

- 独立 Icon Library 文件
- 一图标一个组件，24×24，英文 kebab-case
- 单色，管线会改写成 `currentColor`
- `_` / `.` 开头当草稿
- Figma 里 Publish Library 是给其他设计稿用的；进代码靠这条 CLI

## License

MIT
