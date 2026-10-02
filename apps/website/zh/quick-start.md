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

### 本地监听

配置只包含本地 SVG 目录或 Iconify JSON 文件时，可以运行：

```bash
pnpm exec iconctl watch
pnpm exec iconctl watch --config ./iconctl.config.ts --dry-run --json
```

支持 `directory`、带 `dir` 的 `jsdesign`，带 `dir` 且没有 `url` 的 `iconfont`，以及带本地 `file` 的 `iconify`。Figma、MasterGo 和远程 iconfont URL 继续使用单次 `sync`；监听不提供远程轮询或预览服务器。`init` 现在默认把原始 SVG 放在 `raw-svg`，生成 SVG 放在 `svg`。

文件监听准备完成后执行首次同步。SVG 或配置的 Iconify JSON 新增、修改、删除和来源目录重建在 150 ms 无新事件后触发同步。所有同步串行执行，运行期间的多次变更合并为下一轮。无关的非 SVG 文件、隐藏 SVG 来源目录、生成产物和缓存不会触发来源同步。与 `sync` 一样，多个来源目录可以重叠。

保存主配置或本地 `extends` 配置层时，先取消当前同步并等待其结束，再禁用模块缓存重载配置、重建监听路径。`extends` 支持本地相对路径或绝对路径。任意 `import` 的辅助文件不在监听范围内，修改后请保存主配置或重启监听。启动时配置无效会直接失败；运行期间遇到语法错误、配置文件丢失或不支持的来源时，会暂停同步，修复后自动恢复，不会继续使用旧配置写入。来源导入和校验失败可恢复；`--continue` 显式允许部分产物，`--dry-run` 保持单次同步的行为。

来源根目录不能包含、等于或位于生成的 SVG／JSON 包目录内，也不能位于缓存内。任何输出和缓存都不能覆盖配置文件，生成的 `.svg` 文件也不能放在来源内。导入前会校验真实路径和可达目录链接，拒绝指向产物／缓存的别名及链接循环。推荐使用彼此分离的 `raw-svg`、`svg` 和 `packages/icons`。JSON、TypeScript、HTML 输出文件可以位于 SVG 来源内，但不能替换配置或 Iconify 输入文件。配置的 Iconify 输入不能与任何输出文件、产物目录或缓存重叠。`ready.roots` 事件同时列出 SVG 目录和 Iconify 文件。自定义缓存应放在来源外或隐藏目录内，因为导入器会遍历可见子目录。

`--json` 在 stdout 每行输出一个紧凑 JSON 对象：`ready`、`start`、`result`、`error` 或 `stopped`。每轮有递增的 `runId`；`start.reason` 为 `initial`、`source` 或 `config`。`result` 与 `sync --json` 使用相同摘要，不包含 SVG 内容；错误只序列化 `name`、`message` 和可用的 `issues`。人类可读日志写入 stderr。可恢复错误不会结束进程，致命错误退出码为 1。SIGINT／SIGTERM 等待当前同步结束、关闭监听后分别以 130／143 退出。

```ts
import { IconctlAbortError, watch } from 'iconctl'

const controller = new AbortController()
try {
  await watch({
    cwd: process.cwd(),
    signal: controller.signal,
    onEvent(event) {
      if (event.type === 'result') console.log(event.result.diff)
    },
  })
}
catch (error) {
  if (!(error instanceof IconctlAbortError)) throw error
}
// 在应用的退出处理器中调用 controller.abort()。
```

长期运行的 Promise 会在取消清理完成、发出 `stopped` 事件后以 `IconctlAbortError` 拒绝；结束后不会继续写入。已有同步提交边界仍然适用：提交若已开始，会先完成，再继续配置重载或退出。

### 离线比较

直接比较两份本地 Iconify JSON，不加载配置、凭据或远程来源：

```bash
pnpm exec iconctl diff before.json after.json
pnpm exec iconctl diff before.json after.json --html reports/diff.html
pnpm exec iconctl diff before.json after.json --json --check
pnpm exec iconctl diff before.json after.json --html reports/diff.html --dry-run
```

比较包括图标和别名，会解析别名链、继承尺寸（省略时默认 16 × 16）、偏移、旋转、翻转及隐藏状态。别名与具体图标解析后的值相同时视为未变化；父图标变化会影响依赖它的别名。SVG body 在应用变换后按文本比较，因此语义等价的不同路径写法、不同优化结果仍可能被报告为变化；它不进行像素或几何等价比较。

前缀变化单独报告：同名图标可以保持未变化，但 `prefixChanged` 和 `hasChanges` 为 true。图标或前缀变化时，`--check` 在写入请求的报告后以 1 退出；未加此选项的有效比较以 0 退出。JSON、尺寸、缺失或循环别名等错误会使整个比较失败，以 1 退出并保留已有报告。

`--json` 输出一个对象，包含 `before`、`after`（绝对 `file` 路径和 `prefix`）、`prefixChanged`、`hasChanges`、排序后的 `added`、`removed`、`changed`、`unchanged` 数组及 `outputFiles`，不改变 `sync --json`。`--dry-run` 执行比较和目标路径检查，返回 `dryRun: true`、`outputFiles: []`，不创建文件、目录或缓存。

HTML 报告可离线搜索名称、筛选变化、查看数量和前后预览，无外部资源。元数据经过转义，SVG body 作为独立图片文档展示，内容安全策略只允许报告固定的脚本和样式。普通 `preview` 画廊也使用相同的图片隔离和别名渲染。报告不能覆盖任一输入，包括符号链接或硬链接别名；写入使用暂存替换，同一目标请串行写入。

`iconctl` 和 `@iconctl/core` 均提供以下 API：

```ts
import { compareIconSets, diffIconSets, renderDiffHtml, writeDiffHtml } from 'iconctl'

const comparison = compareIconSets(beforeJson, afterJson)
console.log(comparison.hasChanges, comparison.prefixChanged)
const html = renderDiffHtml(comparison)
await writeDiffHtml('reports/diff.html', comparison, {
  inputs: ['before.json', 'after.json'],
})
// 已有同步 API 保持四个数组的返回结构。
const diff = diffIconSets(beforeJson, afterJson)
```

`compareIconSets(undefined, afterJson)` 将全部图标视为新增。`writeDiffHtml` 支持 `dryRun: true`；在自定义集成中传入 `inputs` 可保护来源文件。渲染函数只返回字符串，不写文件。

## 5. 使用 JSON

在 `@iconify/tailwind4` 或 UnoCSS 里把自定义 collection 指到 `icons.json`，然后写 `i-brand-arrow-left`。这个 class 是 CSS mask，不是字体。

给别的开发两种拿法：JSON **跟应用仓一起走**，或发成 **可安装的包**。见[分发](/zh/distribute)。

## 私有线上控制台

需要在网页管理多项目、授权续期、快照审核和 npm 发布时，参阅[控制台接入](./console)。
