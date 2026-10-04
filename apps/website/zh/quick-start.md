# 快速开始

## 1. 安装

```bash
pnpm add -D iconctl
```

## 2. 写配置

```bash
pnpm exec iconctl init
```

在交互终端中，向导只询问尚未提供的值，支持本地目录、Iconify JSON、Figma、MasterGo、iconfont 和即时设计来源。初始化只创建配置，不获取图标、不执行鉴权、不创建来源目录、不运行同步；输入文件可在之后准备。取消提示不会写入配置，退出码为 130。

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
    sprite: 'icons.svg', // 可选的 SVG symbol 集合
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

### 脚本化初始化

脚本和 CI 可显式提供参数：

```bash
pnpm exec iconctl init --source directory --input ./raw-svg --prefix brand --no-interactive --json
```

`--no-interactive`、`--json` 或非交互终端都会禁用提示。此时必须提供 `--source`、`--prefix` 和来源位置（`--input`，远程 iconfont 使用 `--url`）；缺少必填值以状态码 1 失败。在交互终端中，已提供的值会保留，只询问缺少的字段。

| 选项 | 含义 |
| --- | --- |
| `--source <type>` | `directory`、`iconify`、`figma`、`mastergo`、`iconfont` 或 `jsdesign` |
| `--input <value>` | `directory`、`jsdesign` 和本地 `iconfont` 的目录；`iconify` 的本地 JSON 文件；`figma` 的文件 URL／key；`mastergo` 包含 `layer_id` 的文件 URL |
| `--url <url>` | 远程 iconfont Symbol JS URL；仅适用于 `iconfont`，不能与 `--input` 同用 |
| `--prefix <name>` | Iconify 前缀；禁用提示时必填 |
| `--json-output <file>` | 生成配置中的 `output.json`，默认为 `icons.json` |
| `--config <file>` | 新建的 TypeScript 配置目标，默认为 `./iconctl.config.ts`，必须以 `.ts` 结尾 |
| `--no-interactive` | 禁用提示，不会自动填充必填的来源信息 |
| `--json` | 禁用提示，向 stdout 输出且仅输出一个成功或失败 JSON 对象 |
| `--dry-run` | 验证计划和目标，不创建文件、目录、临时文件或缓存 |

远程 iconfont 使用 `--source iconfont --url https://at.alicdn.com/t/c/font_123456_abcdef.js --prefix brand`；已下载的 iconfont SVG 使用 `--source iconfont --input ./iconfont --prefix brand`。生成的 iconfont 配置保留 `stripPrefix: 'icon-'`。

向导保留原有默认值：前缀 `brand`、本地目录 `./raw-svg`、Iconify 文件 `./vendor/icons.json`、iconfont 目录 `./iconfont`、即时设计目录 `./jsdesign-svg`。生成的 SVG 仍输出到 `svg`，预览仍输出到 `preview.html`。Iconify 初始化不设置宽高校验，保留集合的原始尺寸；其他来源保留模板的 24 × 24 默认校验。请将 SVG 输入与生成目录分开。配置或 Iconify 输入与计划中的 JSON、SVG、预览输出冲突时，初始化会拒绝创建；已有文件的别名也会检查。

在 macOS 和 Windows 上，即使路径尚不存在，仅字母大小写不同也会保守地按同一位置处理。请勿仅靠大小写隔离输入、配置和输出路径；Linux 保留大小写区分。

所有相对路径都以当前工作目录为基准；即使 `--config` 指向子目录，来源和输出路径的基准也不改变。例如，始终在项目根目录运行：

```bash
pnpm exec iconctl init --source iconify --input ./vendor/icons.json --prefix brand --json-output ./generated/icons.json --config ./config/brand.config.ts --no-interactive --json
pnpm exec iconctl sync --config ./config/brand.config.ts
```

`init` 绝不覆盖指定的精确目标，已有文件、目录或符号链接都会拒绝。其他进程在发布前创建的目标同样会保留。没有 `--force` 选项。已有项目请直接编辑配置；需要另一份模板时，使用新的 `--config` 目标。初始化不加载或迁移已有配置。`--continue` 不适用于初始化，会被拒绝。

成功 JSON 包含配置绝对路径和创建的文件：

```json
{
  "configFile": "/project/iconctl.config.ts",
  "sourceType": "directory",
  "prefix": "brand",
  "outputFiles": ["/project/iconctl.config.ts"]
}
```

添加 `--dry-run --json` 可在零写入的情况下验证同一计划，结果增加 `dryRun: true`，并返回 `outputFiles: []`。目标已存在时仍会失败；dry-run 不会为后续执行预留目标。失败使用[通用 JSON 失败报告](#json-失败报告)，其中 `command: "init"`。

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

### SVG sprite

可选配置 `output.sprite: 'icons.svg'` 会生成一份 SVG，按名称排序，为每个已解析的图标、变体或别名生成一个 `<symbol>`。ID 格式为 `iconctl-${prefix}-${name}`，例如前缀 `brand`、名称 `home` 对应 `iconctl-brand-home`。每个 symbol 都有独立的 `viewBox`，保留解析后的翻转、旋转及处理后的颜色，包括 `currentColor`。内部 ID 会按 symbol 重写，避免渐变、遮罩等本地引用相互冲突。

将生成文件部署在应用同源地址，装饰性图标可以这样引用：

```html
<svg width="24" height="24" aria-hidden="true">
  <use href="/icons.svg#iconctl-brand-home"></use>
</svg>
```

内联使用时，将生成的 SVG 在页面中插入一次，再引用 `#iconctl-brand-home`。下面省略了其他 symbol，并为表达信息的图标提供无障碍名称：

```html
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
  <symbol id="iconctl-brand-home" viewBox="0 0 24 24">
    <path fill="currentColor" d="M3 10 12 3l9 7v11h-6v-7H9v7H3Z"></path>
  </symbol>
</svg>
<svg width="24" height="24" role="img" aria-label="首页">
  <use href="#iconctl-brand-home"></use>
</svg>
```

相邻文字已表达含义时使用 `aria-hidden="true"`；图标本身承载信息时，使用有意义的 `aria-label` 和 `role="img"`。

Sprite 的前缀、图标名称及内部 ID 必须是匹配 `[A-Za-z0-9_.:-]+` 的非空 ASCII 字符串，允许数字开头。不支持的名称会明确报错，不会自动改名。支持本地 `href="#id"`、`xlink:href="#id"`、ARIA ID 引用，以及完整的本地 `url(#id)` 值；允许 `url( '#id' )` 等带引号形式及周围空白。重复 ID、找不到目标的引用及 URL 回退表达式会被拒绝。

这一静态格式拒绝残余 CSS 样式或样式表、SMIL 动画、脚本、事件属性、`foreignObject`、外部引用及不支持的 SVG 元素。XML 属性可使用单引号或双引号，实体会正确解析，混合文本会保留；DTD 和处理指令会被拒绝。这些检查定义 sprite 支持的格式，不是完整的 SVG 清洗器；校验面向已处理的 SVG，无法恢复来源清理阶段删除的内容。

Sprite 与 JSON、独立 SVG、类型、预览和 changelog 一起参与已有[输出事务](#同步完整性与取消)，目标冲突会在替换前拒绝。Sprite 内容也纳入完成缓存校验：文件缺失或被修改时，即使远端元数据未变，下次同步也会重新校验。`output.types` 包含已解析的图标、变体和别名名称，并输出为经过转义的 TypeScript 字符串字面量。

`watch` 会在来源修改后更新 sprite，并将生成文件排除在变化触发范围之外。请把 `icons.svg` 放在 SVG 来源目录外；来源与输出冲突、符号链接别名都会校验，输出也不能替换配置或 Iconify 输入文件。`sync --dry-run` 和 `watch --dry-run` 仍校验 sprite 的静态格式，同时跳过图标产物写入。

### JSON 失败报告

`init`、`sync`、`preview`、`diff`、`check` 和 `auth` 启用 `--json` 后，致命失败会向 stdout 输出一份 JSON 报告，退出码为 1；CLI 不会在 stderr 重复打印同一错误。例如，同步校验失败会保留已知的来源坐标：

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

`init --json` 为非交互模式，成功时使用[初始化结果](#脚本化初始化)。Watch 保留下文的独立 NDJSON 生命周期。`--no-json` 或 `--json=false` 使用人类可读诊断。作为库调用 `runCli()` 时，报告输出后仍会 reject 原始错误对象。

### 同步完整性与取消

默认情况下，`sync()` 遇到 Figma 导出 URL 缺失、SVG 下载／导入失败、处理或校验失败，会在替换产物前拒绝同步。目录中的无效 SVG、MasterGo 条目和 iconfont symbol 会与其余来源图标一并报告。`IconctlSyncError.issues` 提供图标名称、失败阶段，以及可用的来源索引、文件标识和 Figma 节点 ID。CLI 默认非 0 退出并保留原有产物。

处理与校验问题指向最终成功提供该图标的来源。`sourceIndex` 对应 `sources` 中从零开始的位置；Figma 图标即使经过自定义命名或同名覆盖，也会保留对应的 `fileKey` 和 `nodeId`。后续本地来源成功覆盖时会更新归属并移除旧 Figma 坐标。导入失败保留其自身诊断，不会夺取先前有效图标的归属。抛出的错误、继续执行和 dry-run 的结果均包含这些信息；调用方直接传入 `iconSet` 时不推测来源坐标。

仅在需要部分产物时启用 `continueOnError: true`（CLI：`--continue`）。此时返回 `complete: false`，`failed`／`issues` 包含失败明细，`diff.deletionsReliable: false` 且 `removed: []`；不更新 changelog，也不保留完整同步缓存标记。认证失败、来源不可读取或 Figma 来源没有任何成功导入的图标时仍然拒绝。CLI 通过警告说明部分结果；`--json` 提供 `complete`、`deletionsReliable`、`skipped` 和 `issues`。显式请求部分成功时保持成功退出状态。

修复来源或网络后，再运行 `sync`。没有有效的完整同步标记时，会重新获取 Figma 文档，立即读取修正后的文件版本。完整同步标记记录校验规则版本及所有已配置产物的文件指纹，包括 SVG、SVG sprite 和清单、JSON 包文件、类型、预览和 changelog。产物缺失、内容改变或标记过旧都会触发完整检查，即使远端文件没有变化。输出目录中的无关文件不影响缓存复用。重新校验会保留修改后的 changelog；已删除的历史无法仅凭当前图标恢复。无效 SVG 响应、不完整的图片导出响应不会从下载缓存复用。

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

合法的嵌套输出会统一准备和提交，包括 JSON 包内文件、SVG、SVG sprite、预览、类型、变更日志和缓存元数据。冲突目标会在替换产物前拒绝。提交完成后若临时目录清理失败，会通过 `ICONCTL_OUTPUT_CLEANUP` 警告报告残留目录，同步仍视为成功。

SVG 输出目录中的 `.iconctl-manifest.json` 记录生成的 SVG，包括别名。只有名称和内容仍与上一份 Iconify JSON 匹配，且被现有清单登记的过期文件才会删除；没有清单时仍需名称和内容匹配。手工修改过或无法确认归属的旧 SVG 会保留；本次生成的同名文件仍会更新。请随 SVG 输出目录一起保留该清单。控制台 runner 会从发布产物中排除这一内部清单。

Promise 结束时，本次调用启动的工作均已结束，不会再写图标产物。已开始的共享 OAuth 刷新及凭据持久化会安全完成后再返回取消，其他同步仍可使用新凭据；自定义认证 provider 也需要先结束，因此可能延迟取消响应。

这不提供跨路径原子发布或进程崩溃恢复。写入相同路径的同步应串行运行。需要严格原子发布时，将全部输出配置到独立的版本目录，成功后再发布目录或切换指针。`dryRun` 仍跳过图标产物，但认证和请求缓存可能更新。

### 本地监听

配置只包含本地 SVG 目录或 Iconify JSON 文件时，可以运行：

```bash
pnpm exec iconctl watch
pnpm exec iconctl watch --config ./iconctl.config.ts --dry-run --json
```

支持 `directory`、带 `dir` 的 `jsdesign`，带 `dir` 且没有 `url` 的 `iconfont`，以及带本地 `file` 的 `iconify`。Figma、MasterGo 和远程 iconfont URL 继续使用单次 `sync`；监听不提供远程轮询或预览服务器。`init` 现在默认把原始 SVG 放在 `raw-svg`，生成 SVG 放在 `svg`。

原生文件系统事件用于唤醒检查；串行元数据扫描还会在上一轮结束后间隔 1 秒重复检查，即使通知丢失也能跟进当前本地输入。150 ms 防抖从观察到变化开始计算；这一补偿机制不会轮询远端来源。校验期间输入变化会在导入前重新检查路径，失败校验期间发生的修复也会保留为下一轮。目录扫描在下探前核对祖先身份，并丢弃不一致的采样。被拒绝的来源链接仍会检查有界目标链的元数据，仅修复外部目标也能恢复校验，无需重新编辑链接。停止监听会取消后续采样，等待已开始的读取结束后再发出 `stopped`。

文件监听准备完成后执行首次同步。SVG 或配置的 Iconify JSON 新增、修改、删除和来源目录重建在 150 ms 无新事件后触发同步。所有同步串行执行，导入期间的多次变更合并为下一轮；导入前发现的变化先重新校验。无关的非 SVG 文件、隐藏 SVG 来源目录、生成产物和缓存不会触发来源同步。与 `sync` 一样，多个来源目录可以重叠。

输入版本未变化的重复发现通知或访问时间变化会被忽略，包括迟到的符号链接发现通知。主配置即使按相同内容重新保存也会重载；文件或链接被替换时仍会触发相应检查。

保存主配置或本地 `extends` 配置层时，先取消当前同步并等待其结束，再加载新配置、重建监听路径。配置候选文件和链接链在读取前记录，并在发出就绪事件前重新核对；首次加载或新增 `extends` 加载期间的修改会触发重新尝试。`extends` 支持本地相对路径或绝对路径。JavaScript、TypeScript 和 JSON 辅助模块会随配置重新加载，包括 `.mjs`、`.cjs`、ESM `.js` 和 `createRequire()` 导入。任意 `import` 的辅助文件不在监听范围内，修改后请保存主配置或重启监听。启动时配置无效会直接失败；运行期间遇到语法错误、配置文件丢失或不支持的来源时，会暂停同步，修复后自动恢复，不会继续使用旧配置写入。来源导入和校验失败可恢复；`--continue` 显式允许部分产物，`--dry-run` 保持单次同步的行为。

Watch 在独立的 Node.js Worker 中加载并执行每一版配置。来源文件变更会复用该版配置及其函数、正则表达式和模块状态；配置重载则先释放旧 Worker，再创建新的模块与依赖包状态。同一版配置内保持模块身份一致，但不会共享调用进程中的全局对象、包单例或代码补丁。`process.env` 仍然共享，`process.cwd()` 跟随调用进程，`process.argv` 在配置加载时复制；配置代码须遵守 Node Worker 的限制，例如不能调用 `process.chdir()`。独立的 `loadConfig()` 和 `sync()` API 仍在调用进程中执行。

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

### 预览本地集合

直接从已有 Iconify JSON 生成支持搜索和复制的 HTML 画廊：

```bash
pnpm exec iconctl preview --input ./icons.json
pnpm exec iconctl preview --input ./vendor/icons.json --output ./reports/vendor.html
pnpm exec iconctl preview --input ./icons.json --output ./reports/preview.html --dry-run --json
```

本地预览不加载或执行配置、不联系来源、不访问凭据、不更新缓存，只写指定 HTML 和必要的父目录。输入、输出路径均相对当前目录解析；即使输入位于别处，默认目标仍为 `./preview.html`。只接受本地文件路径，拒绝 URL、空白值、重复路径选项和表示 stdin/stdout 的 `-`；真实文件名的前后空格会保留。

`--output` 必须与 `--input` 同用。本地输入不能与 `--config` 或 `--continue` 同用。省略 `--input` 时，预览保持已有配置同步行为，包括 `output.preview`、全部配置产物、来源访问、部分成功结果及 sync JSON 汇总。

本地 `--json` 结果包含绝对文件路径和全部已解析图标、别名的数量，隐藏项也计入：

```json
{
  "input": { "file": "/project/icons.json", "prefix": "brand" },
  "count": 2,
  "outputFiles": ["/project/preview.html"]
}
```

本地 `--dry-run` 会解析、渲染集合，并检查目标及输入冲突；报告增加 `dryRun: true`，返回 `outputFiles: []`，不创建文件、目录、暂存区或缓存。JSON、尺寸、缺失或循环别名等错误会使整次操作失败，并保留已有 HTML。失败使用[通用 JSON 错误结构](#json-失败报告)，其中 `command: "preview"`；路径参数错误处于 `arguments` 阶段，读取、集合解析和输出错误处于 `execution` 阶段。

预览接受 UTF-8 BOM，保留自定义名称及 SVG body，并为显示解析继承几何信息和别名变换。它不优化 SVG，不执行名称或画布规则校验；需要 SVG 处理与校验时使用 `check --input`。HTML 继续采用独立 SVG 图片、固定内容安全策略，禁用 JavaScript 后仍展示完整画廊。

`iconctl` 和 `@iconctl/core` 均导出渲染与写入 API：

```ts
import { renderPreviewHtml, writePreviewHtml, type WritePreviewHtmlOptions } from 'iconctl'

const html = renderPreviewHtml(iconsJson)
const options: WritePreviewHtmlOptions = { inputs: ['icons.json'] }
await writePreviewHtml('reports/preview.html', iconsJson, options)
```

原有双参数 writer 继续可用。传入 `inputs` 可保护来源文件，包括硬链接、目录符号链接和输入符号链接别名；CLI 会自动传入输入。输出叶子节点不能是符号链接（包括悬空链接）或目录。writer 在暂存前完成渲染，支持 `dryRun: true`，并使用与 `writeDiffHtml` 相同的事务替换报告。同一目标请串行写入。单独渲染只返回字符串，不写文件。

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

### 将本地 JSON 转成 sprite

已有 Iconify 集合时，可以直接导出静态 sprite：

```sh
iconctl sprite --input ./collection.json
iconctl sprite --input ./collection.json --output ./assets/icons.svg --json
iconctl sprite --input ./collection.json --output ./new/icons.svg --dry-run --json
```

`--input` 必填；`--output` 默认为当前目录下的 `icons.svg`。两者均为本地路径，相对路径以当前目录为基准。URL、代表 stdin/stdout 的 `-`、重复路径参数、`--config` 和 `--continue` 会被拒绝。命令读取完整集合，不加载配置、凭据、远端来源或缓存，只写 sprite，不另写 JSON。需要选择图标、合并来源、处理颜色或 watch 时，请使用配置来源和 `output.sprite`。

所有可解析图标和别名都会导出，包括 hidden 图标以及含 `_` 或 `.` 的名称。Hidden 元数据不会转成 SVG 可见性属性。每个 symbol 保留解析后的视口、旋转、翻转和原始颜色；缺少尺寸时默认为 16×16。空集合会生成空 SVG 根节点，count 为零。前缀和名称遵循 [sprite 格式](#svg-sprite)，仅支持 ASCII 字母、数字、`_`、`.`、`:` 和 `-`，不会自动重命名。

整个集合必须有效。坏别名、非法尺寸、`not_found` 项或不支持的 SVG 都会使本次导出整体失败。直接转换不会清理来源：经过配置来源清理后可用的 JSON，直接转换时仍可能因非空 `style`、样式表或动画而失败。现有静态格式拒绝脚本／事件属性、`foreignObject`、SMIL、外部资源、跨图标或悬空引用、DTD、处理指令及非法 XML。局部 href、颜色和 ARIA 引用会在各自 symbol 内重写。这是静态导出器，不是完整的 SVG 清洗器。

成功 JSON 为 `{ input: { file, prefix }, count, outputFiles }`，路径为绝对路径，count 包含所有生成的 symbol。Dry-run 增加 `dryRun: true`，并返回 `outputFiles: []`；仍会完整渲染和校验目标，但不创建输出、父目录、staging 文件或缓存。参数错误和执行错误沿用公共 JSON 错误结构，`command` 为 `"sprite"`。已有普通输出文件可替换；输出不能通过直接路径、符号链接别名或硬链接覆盖输入，输出末级符号链接和目录也会被拒绝。校验或 staging 写入失败会保留原文件。共享事务会回滚失败的提交；恢复或清理失败沿用[既有事务诊断](#同步完整性与取消)。

`iconctl` 和 `@iconctl/core` 均提供相同的异步 API 与类型：

```ts
import { renderSvgSprite, writeSvgSprite, type SvgSpriteSummary, type WriteSvgSpriteOptions } from 'iconctl'

const svg: string = await renderSvgSprite(iconsJson)
const options: WriteSvgSpriteOptions = { inputs: ['collection.json'], dryRun: true }
const summary: SvgSpriteSummary = await writeSvgSprite('assets/icons.svg', iconsJson, options)
// summary: { prefix, count }；普通写入在发布成功后返回相同结构。
```

`renderSvgSprite` 返回字节稳定、以换行结尾的 SVG，不写文件。`writeSvgSprite` 只准备一次集合，再校验并发布这些字节。库调用者通过 `inputs` 传入需要保护的源文件，CLI 会自动传入输入路径。不需要保护源文件时，可以直接使用两个参数的 writer 调用。

### 从本地 JSON 生成类型

已下载的快照或第三方集合可直接生成名称类型，无需配置来源：

```sh
iconctl types --input ./collection.json
iconctl types --input ./collection.json --output ./src/icon-names.ts --json
iconctl types --input ./collection.json --output ./new/icons.d.ts --dry-run --json
```

`--input` 必填，默认输出到当前目录的 `icons.d.ts`。`.d.ts` 提供类型检查所需的声明；应用需要在运行时导入 `ICONIFY_PREFIX` 时，使用 `.ts`。两种文件都导出原始前缀字面量和 `IconName` 联合类型。名称按确定顺序排列，包含 hidden 图标和已解析别名，保留原始字符并进行 TypeScript 字面量转义。空集合生成 `IconName = never`。

命令只读取本地 JSON，接受 UTF-8 BOM，只写指定类型文件；不执行配置、不加载来源、不访问凭据、不更新缓存。路径沿用本地命令规则：相对当前目录，保留真实文件名的前后空格；拒绝 URL、`-`、空白或重复路径选项、`--config` 和 `--continue`。来源选择、重命名、颜色处理和监听继续通过配置使用。

整个集合都必须通过结构、尺寸和别名解析检查；缺失／循环别名或无法解析的 `not_found` 项会使整次操作失败。类型生成不渲染或清洗 SVG XML，也不对名称施加 sprite ID 限制，输入字节保持不变。对于已经处理的 sync 结果，`renderIconNameTypes(result.json)` 与同次 sync 的 `output.types` 相同；未经处理的第三方原输入可能在配置来源处理后产生不同名称。

成功 JSON 为 `{ input: { file, prefix }, count, outputFiles }`，路径为绝对路径，count 计入全部已解析名称。`--dry-run` 仍校验集合和目标，返回 `outputFiles: []` 与 `dryRun: true`，不创建文件、父目录、staging 目录或缓存。失败使用公共 JSON 结构，`command` 为 `"types"`：选项错误使用 `arguments`，读取、集合与写入错误使用 `execution`。已有普通文件可替换，但不能通过直接路径、符号链接或硬链接别名覆盖输入；输出末级符号链接和目录也会被拒绝。校验和 staging 写入失败保留原文件，提交回滚与清理沿用[共享输出事务](#同步完整性与取消)。

两个公开包均提供同步 renderer 和异步 writer：

```ts
import { renderIconNameTypes, writeIconNameTypes, type IconNameTypesSummary, type WriteIconNameTypesOptions } from 'iconctl'

const source: string = renderIconNameTypes(iconsJson)
const options: WriteIconNameTypesOptions = { inputs: ['collection.json'], dryRun: true }
const summary: IconNameTypesSummary = await writeIconNameTypes('icons.d.ts', iconsJson, options)
// summary: { prefix, count }
```

库调用者通过 `inputs` 保护源文件，CLI 自动传入输入路径。`@iconctl/core` 现有的底层 `generateIconNameTypes(prefix, names)` 继续用于调用方提供的名称列表。

## 5. 使用 JSON

在 `@iconify/tailwind4` 或 UnoCSS 里把自定义 collection 指到 `icons.json`，然后写 `i-brand-arrow-left`。这个 class 是 CSS mask，不是字体。

给别的开发两种拿法：JSON **跟应用仓一起走**，或发成 **可安装的包**。见[分发](/zh/distribute)。

## 私有线上控制台

需要在网页管理多项目、授权续期、快照审核和 npm 发布时，参阅[控制台接入](./console)。

## 在本仓库开发 CLI

Workspace 可执行入口通过 Node 类型擦除直接运行 `apps/cli/dev/index.ts`。先构建公开的 core 依赖，再从本地图标包调用真实入口：

```sh
pnpm --filter @iconctl/core build
pnpm --filter @iconctl/icons exec iconctl --help
pnpm --filter @iconctl/icons exec iconctl --version
pnpm --filter iconctl start --help
```

CLI 源码修改会立即生效；修改 core 源码后需要重新构建 `@iconctl/core`，或保持它的 `dev` 监听运行。原生入口要求 Node 22.13 或更新版本，CLI 内部相对导入须带 `.ts` 扩展名。Node 22.13 会输出类型擦除的实验性警告。导入 CLI 库的公开入口不会自动执行命令。

发布包使用 `bin/index.js` 和编译后的 `dist` 文件。`--version` 与 `-v` 使用 CLI 自身的包版本，不受当前目录或调用方项目版本影响。发布产物的版本在构建时写入：修改 CLI 源码或包 metadata 后，须先运行 `pnpm --filter iconctl... build` 再打包。仓库 release 流程会在版本更新后构建；手动 pack 也需要当前构建产物。

回归验证区分原生源码执行、已打包的开发入口和发布入口。要保持构建工具使用当前 Node，同时用另一个已安装的 Node 验证原始源码进程，可执行：

```sh
ICONCTL_NATIVE_NODE=/absolute/path/to/node pnpm exec vitest run --project iconctl apps/cli/test/native-cli.test.ts
```

### Workspace 构建缓存

Website 和 Console 的包级 Turbo 输入覆盖受版本控制的页面、主题、公开资源、HTML 入口及构建脚本。Plugin 构建包含内联 UI 脚本，CLI 类型检查包含原生 `dev` 入口。Website 任务还直接追踪 icons 包的 JSON 和 changelog，因为这两个文件被直接导入，icons 包没有构建步骤。上游任务的 hash 会把这些变化传递到 Console 构建。

这些输入在 repoctl 受管默认配置上扩展。仓库专用输入应放在各包的 `turbo.json`；生成的 `dist`、VitePress 缓存、Wrangler 状态和 Worker 类型声明继续排除。输入未变化时可以复用成功任务，任务实际读取的文件发生变化时会使缓存失效。

常规 `pnpm exec repo check --full` 包含缓存回归：它在隔离 fixture 中使用真实包依赖图和配置，让 Turbo 计算 hash，检查代表输入变化、下游失效，以及生成文件不改变 hash。可单独运行：

```sh
pnpm exec vitest run --project iconctl apps/cli/test/build-cache.test.ts
```

排查缓存行为时，可用 `pnpm exec turbo run build --force` 做一次重新构建。它只绕过当次缓存复用；永久输入修复仍应落在包级配置中。
