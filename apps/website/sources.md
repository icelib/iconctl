# Other sources

`iconctl` treats Figma as one input. A local SVG folder, MasterGo, iconfont, and 即时设计 use the same `sources` list.

## Local SVG

No token. Put one `.svg` per icon in a folder:

```ts
{
  type: 'directory',
  dir: './raw-svg',
}
```

Same conventions as Figma: kebab-case names (`arrow-left`, `userFilled.svg` becomes `user-filled`), `_` or `.` prefixes are drafts and skipped, monochrome fills become `currentColor`. Set `validate.width` / `validate.height` if you want a fixed canvas.

`iconctl sync` writes Iconify JSON the same way as a Figma source.

## Local Iconify JSON

Import a vendor collection or the `icons.json` from an installed `@iconify-json/*` package:

```ts
{
  type: 'iconify',
  file: './vendor/icons.json',
  include: ['arrow-left', 'home'], // Omit to import all names; [] imports none.
  namePrefix: 'vendor-', // Literal prefix: home becomes vendor-home.
}
```

`file` is a local path resolved from the command's working directory. The project `prefix` controls the output collection; the input prefix does not rename it. `include` uses exact original icon or alias names, with duplicates removed. Unselected invalid icons do not block a selected subset. `validate.skipPrefix` applies to original names before `namePrefix`; names are then checked by the usual project validation. Names shared by multiple sources follow the existing order: the later source wins. A distinct `namePrefix` avoids those collisions.

Local Iconify collection files must be valid UTF-8. One leading UTF-8 BOM is accepted; malformed byte sequences are rejected instead of being replaced. Valid Unicode, including non-ASCII names and a literal replacement character, is preserved. This encoding rule covers local Iconify collection inputs.

Aliases are resolved through their full parent chain and flattened into independent icons, including horizontal/vertical flips, quarter-turn rotations and inherited dimensions. Missing dimensions default to Iconify's 16×16. Selected hidden icons are imported too; their `hidden` flag and collection/search metadata are not copied to generated outputs. All imported SVGs use the normal cleanup, color conversion and validation pipeline. Set `color: false` to retain vendor colors, and choose canvas validation that fits the vendor set.

Unreadable files, invalid JSON, malformed collection structure and invalid default dimensions stop the source even with `--continue`. Invalid selected entries, broken/cyclic aliases, missing explicit selections and API `not_found` entries produce per-icon issues. The default sync preserves previous outputs; `--continue` exports available icons with `complete: false`, unreliable deletions and no changelog update. `--dry-run` and caller cancellation follow the existing sync contract.

`iconctl watch` supports local Iconify JSON together with local SVG directories. File edits and deletion/recreation trigger serial syncs. Inputs must be separate from all configured output files, SVG/package output directories and caches, including through symlinks; watch rejects conflicting paths. It does not fetch remote Iconify endpoints.

## MasterGo

```ts
{
  type: 'mastergo',
  file: 'https://mastergo.com/file/<fileId>?layer_id=<pageId>',
}
```

Set `MASTERGO_TOKEN` (or `MG_MCP_TOKEN`). The URL must include `layer_id` of the icon page.

This calls MasterGo's official HTTP APIs (`/mcp/extract-svg`). It needs a **Team edition** account, and the file must live in a **team project**, not the draft box.

## iconfont

Public Symbol CDN — no token:

```ts
{
  type: 'iconfont',
  url: 'https://at.alicdn.com/t/c/font_123456_abcdef.js',
  stripPrefix: 'icon-',
}
```

Or a downloaded iconfont folder:

```ts
{
  type: 'iconfont',
  dir: './iconfont',
  stripPrefix: 'icon-',
}
```

iconfont canvases are often 1024×1024. Do not set `validate.width: 24` for that source.

iconctl does not log into iconfont.cn with cookies.

## 即时设计

There is no stable public REST that a CLI/CI job can call. Official docs are plugin APIs; the community MCP needs a local plugin and WebSocket.

Export SVG from 即时设计, then:

```ts
{
  type: 'jsdesign',
  dir: './jsdesign-svg',
}
```

A `js.design` file URL will fail with that explanation instead of a bare 403.
