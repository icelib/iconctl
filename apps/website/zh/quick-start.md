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

### JSON 失败报告

`sync`、`preview`、`diff`、`check` 和 `auth` 启用 `--json` 后，致命失败会向 stdout 输出一份 JSON 报告，退出码为 1；CLI 不会在 stderr 重复打印同一错误。例如，同步校验失败会保留已知的来源坐标：

```json
{
  "success": false,
  "command": "sync",
  "error": {
    "name": "IconctlSyncError",
    "message": "Icon processing or validation failed: ...",
    "phase": "execution",
    "issues": [
      {
        "name": "arrow-left",
        "message": "Expected width 24, received 16",
        "stage": "validation",
        "sourceType": "figma",
        "sourceIndex": 0,
        "fileKey": "example-file",
        "nodeId": "12:34"
      }
    ]
  }
}
```

`error.phase` 表示能够确定的命令环节：`arguments` 是参数或选项错误，`configuration` 是配置加载失败，`authentication` 是 `auth` 命令执行鉴权操作失败，其他执行错误使用 `execution`。它不会根据报错文案猜测根因：同步内部抛出的凭据或网络错误仍归为 `execution`。逐图问题的 `issues[].stage` 则独立表示导入、处理或校验阶段。没有问题明细或来源坐标时会省略对应字段，失败报告不会虚构 diff 或输出文件。

成功 JSON 格式保持不变，包括显式 `--continue` 得到的部分成功结果。 合法的 `diff --check` 比较发现变化时，仍输出原有差异报告并以 1 退出，不属于致命错误。失败的 `check` 报告保留原有顶层 `prefix`、`count`、`source`、`valid`、`issues`，增加 `success`、`command` 和 `error`；`error.issues` 与顶层 `issues` 内容相同。使用严格 schema 的消费者需要允许这些新增失败字段。其他命令此前在致命失败时不输出 JSON，现在可直接解析失败报告。

`init --json` 的致命失败也使用这一报告，但初始化仍是交互命令，不提供成功 JSON 协议。Watch 保留下文的独立 NDJSON 生命周期。`--no-json` 或 `--json=false` 使用人类可读诊断。作为库调用 `runCli()` 时，报告输出后仍会 reject 原始错误对象。

### 同步完整性与取消

默认情况下，`sync()` 遇到 Figma 导出 URL 缺失、SVG 下载／导入失败、处理或校验失败，会在替换产物前拒绝同步。目录中的无效 SVG、MasterGo 条目和 iconfont symbol 会与其余来源图标一并报告。`IconctlSyncError.issues` 提供图标名称、失败阶段，以及可用的来源索引、文件标识和 Figma 节点 ID。CLI 默认非 0 退出并保留原有产物。

处理与校验问题指向最终成功提供该图标的来源。`sourceIndex` 对应 `sources` 中从零开始的位置；Figma 图标即使经过自定义命名或同名覆盖，也会保留对应的 `fileKey` 和 `nodeId`。后续本地来源成功覆盖时会更新归属并移除旧 Figma 坐标。导入失败保留其自身诊断，不会夺取先前有效图标的归属。抛出的错误、继续执行和 dry-run 的结果均包含这些信息；调用方直接传入 `iconSet` 时不推测来源坐标。

仅在需要部分产物时启用 `continueOnError: true`（CLI：`--continue`）。此时返回 `complete: false`，`failed`／`issues` 包含失败明细，`diff.deletionsReliable: false` 且 `removed: []`；不更新 changelog，也不保留完整同步缓存标记。认证失败、来源不可读取或 Figma 来源没有任何成功导入的图标时仍然拒绝。CLI 通过警告说明部分结果；`--json` 提供 `complete`、`deletionsReliable`、`skipped` 和 `issues`。显式请求部分成功时保持成功退出状态。

修复来源或网络后，再运行 `sync`。没有有效的完整同步标记时，会重新获取 Figma 文档，立即读取修正后的文件版本。完整同步标记也记录校验规则版本；升级后旧标记会触发完整检查，即使远端文件没有变化。无效 SVG 响应、不完整的图片导出响应不会从下载缓存复用。

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

输入版本未变化的重复发现通知或访问时间变化会被忽略，包括迟到的符号链接发现通知。主配置即使按相同内容重新保存也会重载；文件或链接被替换时仍会触发相应检查。

保存主配置或本地 `extends` 配置层时，先取消当前同步并等待其结束，再禁用模块缓存重载配置、重建监听路径。`extends` 支持本地相对路径或绝对路径。任意 `import` 的辅助文件不在监听范围内，修改后请保存主配置或重启监听。启动时配置无效会直接失败；运行期间遇到语法错误、配置文件丢失或不支持的来源时，会暂停同步，修复后自动恢复，不会继续使用旧配置写入。来源导入和校验失败可恢复；`--continue` 显式允许部分产物，`--dry-run` 保持单次同步的行为。

来源根目录不能包含、等于或位于生成的 SVG／JSON 包目录内，也不能位于缓存内。任何输出和缓存都不能覆盖配置文件，生成的 `.svg` 文件也不能放在来源内。开始监听和每次导入前都会校验链接及其目标，拒绝指向产物／缓存的别名及链接循环。启动时链接结构无效会失败；运行期间新增的无效链接会暂停同步，修复后恢复。合法的外部 SVG 和 JSON 目标会持续监听，包括目标替换和删除后重建。推荐使用彼此分离的 `raw-svg`、`svg` 和 `packages/icons`。JSON、TypeScript、HTML 输出文件可以位于 SVG 来源内，但不能替换配置或 Iconify 输入文件。配置的 Iconify 输入不能与任何输出文件、产物目录或缓存重叠。`ready.roots` 事件同时列出 SVG 目录和 Iconify 文件。自定义缓存应放在来源外或隐藏目录内，因为导入器会遍历可见子目录。

外部链接改变监听范围时，会等待新的监听器就绪，再次检查链接后才开始导入。即使没有收到发现通知，启动过程中新增的链接也会在本轮纳入监听或被拒绝；删除或修复无效链接后会恢复同步，无需重启监听。

如果来源目录在监听器启动过程中被替换为普通文件，监听会完成初始化并报告可恢复的来源错误。已有产物保持不变，重新创建该目录后会通过父目录监听恢复同步。取消操作也会关闭仍在启动的监听器。这一修复随安装后的 core 和 CLI 包一起提供。

Core 在 Node.js 22.13 及以上版本支持 `import` 和同步 `require()`。CommonJS 入口加载同一份 ESM 实现，其中包含监听修复；两种入口共享命名导出和错误类的身份。

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

### 校验已有产物

可直接校验本地 Iconify 集合，无需先创建 iconctl 配置：

```bash
pnpm exec iconctl check --input ./icons.json
pnpm exec iconctl check --input ./icons.json --width 24 --height 24 --name '^[a-z0-9]+(-[a-z0-9]+)*$' --json
```

`--input` 接收本地文件路径，不加载或执行配置、不读取配置来源、不请求网络、不写文件；不能与 `--config` 同用。默认命名规则为 kebab-case；未传尺寸时不限制画布大小，`--width`／`--height` 必须为有限正数。`--name` 是正则源码字符串，不带斜杠分隔符和 flags。

省略 `--input` 时，`check` 加载配置：设置了 `output.svg` 就检查该目录，否则检查 `output.json`；已配置的 SVG 目录不存在时直接报错。上述参数同样可以覆盖配置中的校验规则。此模式不请求配置来源、不生成产物，但加载用户配置会执行其中的代码。

JSON 别名作为独立命名图标计数。检查前先解析别名链、翻转、旋转和继承几何信息，再校验实际画布；省略尺寸时使用 Iconify 默认的 16×16。所有名称都参与检查，包括隐藏 JSON 图标，以及嵌套或隐藏目录内的原始 SVG 文件名。检查不会重命名 SVG，也不会应用来源的 `skipPrefix` 排除规则；重复 SVG basename 会报错。

`--json` 输出一份报告，保留原有 `prefix`、`count`、`source`、`valid` 和 `issues`；失败时还会包含上文的 [JSON 失败字段](#json-失败报告)。每条问题包含 `stage`（`options`、`read`、`import`、`process` 或 `validation`）、`message`，以及可用的 `name`、`file`。导入、SVG 处理失败会与其余图标的校验失败一起保留。`count` 包括发现的图标／别名或 SVG 文件，失败项也计入；无法确定前缀或来源时，相应字段可为 null。失败退出码为 1，成功为 0；`--continue` 不会使失败检查变为成功。

公开 API 保持原有成功返回结构，可捕获 `IconctlCheckError` 获取结构化诊断：

```ts
import { check, IconctlCheckError } from 'iconctl'

try {
  const result = await check({ input: './icons.json', validate: { width: 24, height: 24 } })
  console.log(result.prefix, result.count, result.source)
}
catch (error) {
  if (!(error instanceof IconctlCheckError)) throw error
  console.error(error.report, error.issues)
}
```

已有 `check({ config })` 调用继续可用。API 命名规则也支持 `RegExp`；带 `g`／`y` 的表达式会在每个名称上从索引零开始匹配，不改变调用方的 `lastIndex`。

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
