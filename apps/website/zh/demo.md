# 演示

这是 **iconctl** 的产出：24 个 [Lucide](https://www.figma.com/community/file/939851755929765537/Lucide-Icons) 图标（ISC），清洗成 `currentColor`、24×24、kebab-case 名称。

## 本地 SVG

当前提交的快照走这条路：一文件夹 `.svg`，不需要 token。

```ts
{
  type: 'directory',
  dir: 'scripts/lucide-svg',
}
```

```bash
pnpm --filter @iconctl/website sync:demo:svg
```

## Figma

同一套图标，从 Lucide Community 文件复制后的 Figma 稿导入。Community 链接不是 REST 的 file key。

```ts
{
  type: 'figma',
  file: process.env.ICONCTL_FIGMA_FILE ?? 'https://www.figma.com/community/file/939851755929765537/Lucide-Icons',
  iconNameForNode: (node) => {
    const name = defaultIconNameForNode(node)
    return name && DEMO_ICON_SET.has(name) ? name : null
  },
}
```

```bash
export FIGMA_TOKEN=figu_xxx
export ICONCTL_FIGMA_FILE=https://www.figma.com/design/<fileKey>/Lucide-Icons
pnpm --filter @iconctl/website sync:demo
```

点击图标复制 `i-demo-arrow-left`。改颜色可以确认填充已被写成 `currentColor`。

<IconDemoGallery />
