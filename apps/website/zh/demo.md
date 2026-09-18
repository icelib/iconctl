# 演示

这是 **iconctl** 从公开的 [Lucide Icons](https://www.figma.com/community/file/939851755929765537/Lucide-Icons) Figma 图标库（ISC）跑出来的结果：24 个组件，清洗成 `currentColor`、24×24、kebab-case 名称。

当前提交的 JSON 快照走的是同一条流水线，源是 Lucide 的公开 SVG。Figma Community 链接不是 REST 的 file key。要从你复制后的 Figma 文件导入：

```bash
export FIGMA_TOKEN=figu_xxx
export ICONCTL_FIGMA_FILE=https://www.figma.com/design/<fileKey>/Lucide-Icons
pnpm --filter @iconctl/website sync:demo
```

在换成 `/design/{fileKey}` 之前，`iconctl` 会拒绝 Community URL。

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

点击图标复制 `i-demo-arrow-left`。改颜色可以确认填充已被写成 `currentColor`。

<IconDemoGallery />
