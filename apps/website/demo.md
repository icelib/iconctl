# Demo

This gallery is **iconctl** output from the public [Lucide Icons](https://www.figma.com/community/file/939851755929765537/Lucide-Icons) Figma library (ISC). Twenty-four components, cleaned to `currentColor`, 24×24, kebab-case names.

The committed JSON snapshot was generated through the same pipeline from Lucide’s public SVGs because Figma Community URLs are not REST file keys. To import the duplicated Figma copy:

```bash
export FIGMA_TOKEN=figu_xxx
export ICONCTL_FIGMA_FILE=https://www.figma.com/design/<fileKey>/Lucide-Icons
pnpm --filter @iconctl/website sync:demo
```

`iconctl` will reject the community URL until you pass that `/design/{fileKey}` link.

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

Click an icon to copy `i-demo-arrow-left`. Change the color to confirm fills were rewritten to `currentColor`.

<IconDemoGallery />
