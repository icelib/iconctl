# Demo

This gallery is **iconctl** output: twenty-four [Lucide](https://www.figma.com/community/file/939851755929765537/Lucide-Icons) icons (ISC), cleaned to `currentColor`, 24×24, kebab-case names.

## Local SVG

The committed snapshot is this path — a folder of `.svg` files, no token:

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

Same icons, from a duplicated Figma copy of the Lucide community file. Community URLs are not REST file keys.

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

Click an icon to copy `i-demo-arrow-left`. Change the color to confirm fills were rewritten to `currentColor`.

<IconDemoGallery />
