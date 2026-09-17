# 快速开始

## 1. 安装

```bash
pnpm add -D figma-iconify
```

## 2. 写配置

```bash
pnpm exec figma-iconify init
```

或手写 `figma-iconify.config.ts`：

```ts
import { defineConfig } from 'figma-iconify'

export default defineConfig({
  file: 'https://www.figma.com/design/<fileKey>/Icons',
  prefix: 'brand',
  pages: ['Icons'],
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

## 3. Token

申请 Figma Personal Access Token，放到环境变量，不要提交进仓库。

```bash
export FIGMA_TOKEN=figu_xxx
```

## 4. 同步

```bash
pnpm exec figma-iconify sync
```

CI：

```bash
pnpm exec figma-iconify sync --json
```

`--dry-run` 只校验不写盘。校验失败默认非 0 退出，并且不写半成品。

## 5. 使用 JSON

在 `@iconify/tailwind4` 或 UnoCSS 里把自定义 collection 指到 `icons.json`，然后写 `i-brand-arrow-left`。
