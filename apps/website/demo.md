# Demo

This gallery uses **`@iconctl/icons`**, a private workspace demo consumed locally by this website. Source of truth is `packages/icons/raw`. `iconctl sync` writes Iconify JSON, SVG, types, `preview.html`, and a dated `CHANGELOG.md` for added, removed, and changed names. The demo is excluded from npm stable and nightly publication.

Click an icon to copy `i-ice-arrow-left`. Change the color to confirm fills were rewritten to `currentColor`.

<IconDemoGallery />

## Add from iconfont

Public Symbol CDN, no token. The script writes `raw/`, then syncs:

```bash
pnpm --filter @iconctl/icons add-iconfont -- https://at.alicdn.com/t/c/font_xxx.js
```

Take a subset with `--only arrow-left,user`. Default prefix strip is `icon-`. Commit the package files and merge the PR to update the documentation preview. The formal site includes the demo in the complete frozen source snapshot of the next `@iconctl/core` or `iconctl` stable release.

Edit or delete SVGs in `raw/` and run `pnpm --filter @iconctl/icons sync` for the same changelog.

Run the icon sync workflow (`.github/workflows/iconctl.yml`) in Actions to pass the same Symbol URL. It opens a PR without release intent.

## Changelog

<IconChangelog />
