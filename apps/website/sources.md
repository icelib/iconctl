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
