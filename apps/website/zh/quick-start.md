# 快速开始

## 1. 安装

```bash
pnpm add -D iconctl
```

## 2. 写配置

```bash
pnpm exec iconctl init
```

或手写 `iconctl.config.ts`：

```ts
import { defineConfig } from 'iconctl'

export default defineConfig({
  prefix: 'brand',
  sources: [
    {
      type: 'figma',
      file: 'https://www.figma.com/design/<fileKey>/Icons',
      pages: ['Icons'],
    },
  ],
  output: {
    json: 'icons.json',
    svg: 'svg',
    preview: 'preview.html',
  },
  validate: {
    width: 24,
    height: 24,
  },
})
```

本地目录不需要 token，产出同一份 Iconify JSON：

```ts
sources: [{ type: 'directory', dir: './raw-svg' }]
```

## 3. Token

Figma 推荐使用 [OAuth 登录与自动续期](/zh/figma#oauth-登录与自动续期)。完成 App 配置后运行 `pnpm exec iconctl auth figma login`，后续同步自动刷新令牌。目录来源不需要凭据。

也可以使用需手动更换的个人令牌：

```bash
export FIGMA_TOKEN=figu_xxx
```

## 4. 同步

```bash
pnpm exec iconctl sync
```

CI：

```bash
pnpm exec iconctl sync --json
```

### 同步完整性与取消

默认情况下，`sync()` 遇到 Figma 导出 URL 缺失、SVG 下载／导入失败、处理或校验失败，会在替换产物前拒绝同步。目录中的无效 SVG、MasterGo 条目和 iconfont symbol 会与其余来源图标一并报告。`IconctlSyncError.issues` 提供图标名称、失败阶段，以及可用的来源索引、文件标识和 Figma 节点 ID。CLI 默认非 0 退出并保留原有产物。

仅在需要部分产物时启用 `continueOnError: true`（CLI：`--continue`）。此时返回 `complete: false`，`failed`／`issues` 包含失败明细，`diff.deletionsReliable: false` 且 `removed: []`；不更新 changelog，也不保留完整同步缓存标记。认证失败、来源不可读取或 Figma 来源没有任何成功导入的图标时仍然拒绝。CLI 通过警告说明部分结果；`--json` 提供 `complete`、`deletionsReliable`、`skipped` 和 `issues`。显式请求部分成功时保持成功退出状态。

修复来源或网络后，再运行 `sync`。没有有效的完整同步标记时，会重新获取 Figma 文档，立即读取修正后的文件版本。无效 SVG 响应、不完整的图片导出响应不会从下载缓存复用。

```ts
import { IconctlAbortError, loadConfig, sync } from 'iconctl'

const config = await loadConfig()
const controller = new AbortController()
const task = sync({ config, signal: controller.signal })
// 在任务取消回调中调用 controller.abort()
try {
  const result = await task
  console.log(result.complete)
}
catch (error) {
  if (!(error instanceof IconctlAbortError)) throw error
  // 也可通过 name === 'AbortError'、code === 'ABORT_ERR' 识别。
}
```

产物先在临时位置生成。提交前取消会保留旧产物并清理临时内容。请求接收 signal（与 Figma 内部超时组合），处理流程在图标之间让出事件循环；单次同步 SVG 运算或已开始的库导出操作需要先结束才能响应取消。提交开始后忽略取消，等待提交完成并返回成功。提交遇到 I/O 错误时尝试恢复旧产物；恢复失败则在错误中指出保留的备份位置。

合法的嵌套输出会统一准备和提交，包括 JSON 包内文件、SVG、预览、类型、变更日志和缓存元数据。冲突目标会在替换产物前拒绝。提交完成后若临时目录清理失败，会通过 `ICONCTL_OUTPUT_CLEANUP` 警告报告残留目录，同步仍视为成功。

SVG 输出目录中的 `.iconctl-manifest.json` 记录生成的 SVG。后续同步据此删除过期产物，并保留无关文件。升级后首次清理旧 SVG 时，只有内容与上一份 Iconify JSON 完全一致的文件才被视作旧产物。无法确认归属的旧文件会保留；本次生成的同名文件仍会更新。请随 SVG 输出目录一起保留该清单。控制台 runner 会从发布产物中排除这一内部清单。

Promise 结束时，本次调用启动的工作均已结束，不会再写图标产物。已开始的共享 OAuth 刷新及凭据持久化会安全完成后再返回取消，其他同步仍可使用新凭据；自定义认证 provider 也需要先结束，因此可能延迟取消响应。

这不提供跨路径原子发布或进程崩溃恢复。写入相同路径的同步应串行运行。需要严格原子发布时，将全部输出配置到独立的版本目录，成功后再发布目录或切换指针。`dryRun` 仍跳过图标产物，但认证和请求缓存可能更新。

## 5. 使用 JSON

在 `@iconify/tailwind4` 或 UnoCSS 里把自定义 collection 指到 `icons.json`，然后写 `i-brand-arrow-left`。这个 class 是 CSS mask，不是字体。

给别的开发两种拿法：JSON **跟应用仓一起走**，或发成 **可安装的包**。见[分发](/zh/distribute)。

## 私有线上控制台

需要在网页管理多项目、授权续期、快照审核和 npm 发布时，参阅[控制台接入](./console)。
