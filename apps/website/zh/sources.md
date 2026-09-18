# 其他来源

Figma 只是一种输入。MasterGo、iconfont、即时设计走同一份 `sources`。

## MasterGo

```ts
{
  type: 'mastergo',
  file: 'https://mastergo.com/file/<fileId>?layer_id=<pageId>',
}
```

设置 `MASTERGO_TOKEN`（也认 `MG_MCP_TOKEN`）。URL 必须带图标页的 `layer_id`。

走的是 MasterGo 官方 HTTP（`/mcp/extract-svg`）。需要**团队版**账号，文件必须在**团队项目**里，不能在草稿箱。

## iconfont

公开 Symbol CDN，不需要 token：

```ts
{
  type: 'iconfont',
  url: 'https://at.alicdn.com/t/c/font_123456_abcdef.js',
  stripPrefix: 'icon-',
}
```

或本地下载包：

```ts
{
  type: 'iconfont',
  dir: './iconfont',
  stripPrefix: 'icon-',
}
```

iconfont 画板经常是 1024×1024，不要给这个来源写死 `validate.width: 24`。

iconctl 不会用 cookie 登录 iconfont.cn。

## 即时设计

没有可供 CLI/CI 使用的稳定公开 REST。官方是插件 API；社区 MCP 要本机插件和 WebSocket。

在即时设计里导出 SVG，然后：

```ts
{
  type: 'jsdesign',
  dir: './jsdesign-svg',
}
```

如果填 `js.design` 文件 URL，会直接告诉你这件事，而不是丢一个 403。
