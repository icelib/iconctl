# Demo

This gallery is **`@iconctl/icons`**, the installable set this repo publishes. Source of truth is `packages/icons/raw`. `iconctl sync` writes Iconify JSON, SVG, types, `preview.html`, and a dated `CHANGELOG.md` for added, removed, and changed names.

Click an icon to copy `i-iconctl-arrow-left`. Change the color to confirm fills were rewritten to `currentColor`.

<IconDemoGallery />

## Add from iconfont

Public Symbol CDN, no token. The script writes `raw/`, then syncs:

```bash
pnpm --filter @iconctl/icons add-iconfont -- https://at.alicdn.com/t/c/font_xxx.js
```

Take a subset with `--only arrow-left,user`. Default prefix strip is `icon-`. Commit the package files; the next docs deploy shows them here.

Edit or delete SVGs in `raw/` and run `pnpm --filter @iconctl/icons sync` for the same changelog.

Actions → **iconctl publish** → Run workflow can pass the same Symbol URL.

## Changelog

<IconChangelog />
