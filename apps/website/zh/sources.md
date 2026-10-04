# 其他来源

Figma 只是一种输入。本地 SVG 目录、MasterGo、iconfont、即时设计走同一份 `sources`。

## 本地 SVG

不需要 token。一个图标一个 `.svg`，放进文件夹：

```ts
{
  type: 'directory',
  dir: './raw-svg',
}
```

约定和 Figma 一样：kebab-case 名称（`arrow-left`，`userFilled.svg` 会变成 `user-filled`），`_` 或 `.` 开头当草稿跳过，单色填充写成 `currentColor`。要固定画板就设 `validate.width` / `validate.height`。

`iconctl sync` 写出的 Iconify JSON 和 Figma 来源同一条流水线。

## 本地 Iconify JSON

可导入已有图标集，或已安装的 `@iconify-json/*` 包内的 `icons.json`：

```ts
{
  type: 'iconify',
  file: './vendor/icons.json',
  include: ['arrow-left', 'home'], // 省略时导入全部名称；[] 不导入任何图标。
  namePrefix: 'vendor-', // 按字面拼接：home 变为 vendor-home。
}
```

`file` 是相对于命令工作目录的本地路径。输出集合使用项目的 `prefix`，不会被输入集合前缀覆盖。`include` 精确匹配原始图标或别名，重复名称会去重；未选中的无效图标不会阻塞子集导入。`validate.skipPrefix` 先匹配原始名称，再拼接 `namePrefix`，最后按项目规则校验名称。多来源同名图标沿用已有顺序：后面的来源覆盖前面的来源；使用不同的 `namePrefix` 可以避免冲突。

本地 Iconify 集合文件必须是有效的 UTF-8。允许一个开头的 UTF-8 BOM；损坏的字节序列会被拒绝，不会替换成其他字符。合法 Unicode（包括非 ASCII 名称和真实的替换字符）会保持不变。这条编码约定适用于本地 Iconify 集合输入。

别名会沿完整父链解析，平铺成独立图标，支持水平／垂直翻转、以 90° 为单位的旋转和尺寸继承。缺失尺寸时采用 Iconify 默认的 16×16。选中的隐藏图标也会导入；其 `hidden` 标记、集合和搜索元数据不复制到生成产物。所有 SVG 继续使用已有清洗、颜色转换和校验流程；保留彩色图标时设置 `color: false`，画板校验应与来源尺寸一致。

文件不可读、JSON 语法错误、集合结构无效或默认尺寸无效时，即使启用 `--continue` 也会拒绝该来源。选中条目损坏、别名断链／循环、显式选择的名称不存在，以及 API `not_found` 条目会产生逐图标诊断。别名失败会附带从选中名称到缺失或无效条目的有序路径，便于修复多级别名。默认同步保留旧产物；`--continue` 导出可用图标，标记 `complete: false`、删除不可靠，并跳过 changelog 更新。`--dry-run` 和调用方取消沿用现有同步契约。

`iconctl watch` 支持将本地 Iconify JSON 与本地 SVG 目录混合监听。文件修改、删除后重建均会触发串行同步。输入必须与所有输出文件、SVG／包输出目录和缓存隔离，软链接也会校验；路径冲突时拒绝监听。不请求远程 Iconify 接口。

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
