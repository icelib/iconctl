# 服务端 SDK

使用 `@iconctl/core`，可以在 Node.js 服务、工作进程或现有任务系统中执行图标同步。运行环境需要 Node.js 22.13 或更高版本，并提供可写文件系统。Figma 凭据和 SDK 执行都放在服务端；浏览器负责提交任务，读取宿主应用提供的进度和错误。

```bash
pnpm add @iconctl/core
```

下文示例只依赖 `@iconctl/core`，无需安装 `iconctl` CLI，也不需要启动子进程。

## 配置与同步

在任务工作目录中创建由应用维护的 `iconctl.config.ts`：

```ts
import type { IconctlConfig } from '@iconctl/core'

export default {
  prefix: 'brand',
  sources: [
    {
      type: 'figma',
      file: 'https://www.figma.com/design/AbCdEf123456/Icons',
      pages: ['Icons'],
    },
  ],
  output: {
    json: 'generated/icons.json',
    preview: 'generated/preview.html',
  },
} satisfies IconctlConfig
```

仅类型导入适用于只安装 core 的服务。也可以从 `@iconctl/core` 导入 `defineConfig` 作为运行时辅助函数。加载配置会执行配置文件及其导入，因此应使用应用自己维护的可信配置。

```ts
import { loadConfig, serializeIconctlError, sync } from '@iconctl/core'

const cwd = '/srv/icon-jobs/brand'
const env = process.env
const controller = new AbortController()
const secrets = [
  env.FIGMA_TOKEN,
  env.FIGMA_CLIENT_ID,
  env.FIGMA_CLIENT_SECRET,
  env.FIGMA_REFRESH_TOKEN,
].filter((value): value is string => Boolean(value))

try {
  const config = await loadConfig({ cwd, configFile: 'iconctl.config.ts' })
  const result = await sync({
    cwd,
    config,
    env,
    signal: controller.signal,
    requestTimeoutMs: 30_000,
    oauthTimeoutMs: 15_000,
    onProgress(event) {
      console.info('icon-sync-progress', event)
    },
  })

  console.info({ complete: result.complete, processed: result.processed })
}
catch (error) {
  const diagnostic = serializeIconctlError(error, { secrets })
  console.error(JSON.stringify(diagnostic))
}

// 在宿主应用的取消处理器中调用：controller.abort()
```

`loadConfig` 和 `sync` 应使用同一个 `cwd`。来源、缓存和输出的相对路径都基于该目录，即使配置文件位于子目录中也是如此。`loadConfig` 返回解析后的配置，不会加载 `.env` 文件；通过 `env` 传入服务端需要的环境变量。对于内存中的配置，先调用 `resolveConfig(config)`，再传给 `sync`。

默认情况下，导入、处理或校验失败会抛出错误，保留已有产物。只有显式设置 `continueOnError: true` 才允许输出部分结果；发布前检查 `result.complete`、`result.issues` 和 `result.diff.deletionsReliable`。部分结果的删除判断不可靠，因此不报告删除项，也不更新变更日志。认证失败、来源不可读，以及 Figma 来源未成功导入任何有效图标时，仍会抛出错误。

## 进度与宿主任务

`onProgress` 接收不可变的 `SyncProgressEvent`。阶段包括 `prepare`、`source`、`document`、`export-url`、`download`、`import`、`process`、`validate`、`export` 和 `complete`。事件包含 `timestamp`，并按情况提供来源坐标、图标名和 `completed` / `total`。

计数表示已结束的尝试，包括失败项。`source` 阶段按配置的来源数计数；Figma 加载阶段按当前 Figma 来源计数。`process` 和 `validate` 则按整个合并后的图标集计数，即使某条事件携带了该图标的来源坐标。这些计数不是全局成功数或整个任务的百分比。

回调按事件顺序调用，返回的 Promise **不会被等待**。异步写入可能乱序完成，也不会为同步过程提供背压。回调抛错或返回的 Promise 拒绝都不会使同步失败；宿主应用需要自行记录观察者的错误。异步发送可以接入自己的队列：

```ts
import type { SerializedIconctlError, SyncProgressEvent } from '@iconctl/core'
import { serializeIconctlError } from '@iconctl/core'

// 由宿主应用实现。
declare function enqueueProgress(event: SyncProgressEvent): Promise<void>
declare function reportProgressFailure(error: SerializedIconctlError): void

function onProgress(event: SyncProgressEvent): void {
  try {
    void enqueueProgress(event).catch((error) => {
      reportProgressFailure(serializeIconctlError(error))
    })
  }
  catch (error) {
    reportProgressFailure(serializeIconctlError(error))
  }
}
```

在宿主中限制队列内存、合并进度更新或控制写入并发，保持回调简短。即使进度发送失败，也应以 `sync()` Promise 的最终状态及返回结果判定任务结果。

core 不分配任务 ID，也不提供持久化任务记录、重试队列或浏览器订阅。宿主负责分配任务 ID、保存状态和脱敏诊断、控制访问权限，并决定重试与保留策略。写入同一输出路径的任务需要串行；不同项目并发时使用独立工作目录。宿主接受同步结果后再发布产物。详见[产物完整性](/zh/quick-start#同步完整性与取消)。

## 结构化错误

存储错误或通过 API 返回错误前，调用 `serializeIconctlError(error, { secrets })`。它返回包含 `name` 和 `message` 的普通 JSON，并保留已知的可选元数据：

| 字段 | 含义 |
| --- | --- |
| `code` | 机器可读分类，例如 `REQUEST_TIMEOUT`、`NETWORK_ERROR`、`FIGMA_HTTP_ERROR` 或 `ABORT_ERR` |
| `httpStatus` | 已知的服务商 HTTP 状态码 |
| `retryable`、`retryAfterMs` | 重试建议；是否重试、何时重试由宿主决定 |
| `sourceType`、`sourceIndex`、`operation` | 已知的来源与操作上下文 |
| `issues` | 图标级失败，包含阶段和可用的来源坐标 |
| `cause`、`errors` | 有数量与长度限制的嵌套原因和聚合错误 |
| `truncated` | 部分详情超过序列化上限 |

序列化器不输出堆栈、请求/响应对象或任意额外属性，会移除可识别的凭据形式和传入的秘密值，包括 URL 编码形式。请提供应用已知的全部凭据，例如来源配置中的 token 或自定义认证提供器持有的令牌。它不会自动发现应用的所有秘密，也不会移除所有文件路径：敏感宿主值可一并放入 `secrets`，或由 API 只输出允许公开的字段。界面中按纯文本展示消息。

超时和限流可以由宿主按有次数上限的策略重试；凭据无效、缺少文件权限则需要修改配置。保存诊断和任务 ID，便于操作者定位失败阶段与来源。

## Figma 超时与取消

| 选项 | 默认值 | 作用范围 |
| --- | --- | --- |
| `requestTimeoutMs` | `30_000` 毫秒 | 每次 Figma API 或 SVG 下载请求，包含响应头和完整响应体 |
| `oauthTimeoutMs` | `15_000` 毫秒 | 每次 Figma OAuth token 或刷新请求，包含响应头和完整响应体 |
| `signal` | 未设置 | 调用者取消同步或诊断 |

超时值必须是有限的正整数。它们限定单次请求的时间，不是整个任务的总时限。OAuth 刷新共享时，`oauthTimeoutMs` 也独立限制每个 token 等待者的等待时间。共享传输使用已加入等待者中最晚的截止时间，后加入且等待更久的调用可以延长它。较短等待者的超时或取消不会截断其他等待者的刷新。同一身份在不同超时策略下仍共享最新的轮换凭据。这些是 SDK 选项，不表示 CLI 一定提供同名参数。远程 Iconify 来源仍遵循其单独说明的传输限制。

产物提交前取消会保留已有产物；提交开始后会完成本次提交。处理过程在同步图标操作之间检查取消。取消一个等待者不会取消其他任务共享的 OAuth 刷新；即使该等待者已收到取消错误，共享刷新仍可能完成，并保存更新后的本地凭据。PAT 不会自动续期。凭据优先级与授权设置见 [Figma 授权](/zh/figma#oauth-登录与自动续期)。

## 检查 Figma 凭据

`inspectFigmaAuth()` 会报告全部凭据来源，不输出 token 或凭据文件路径。默认仅进行本地读取，**不请求网络、不刷新、不写入**。它不会加载项目配置；来源配置有 PAT 时，需要将其作为 `token` 传入。

```ts
import { inspectFigmaAuth } from '@iconctl/core'

const offlineReport = await inspectFigmaAuth({ env: process.env })

// 显式请求网络，检查选中来源能否访问该文件。
const verifiedReport = await inspectFigmaAuth({
  env: process.env,
  verify: true,
  file: 'https://www.figma.com/design/AbCdEf123456/Icons',
  requestTimeoutMs: 30_000,
  oauthTimeoutMs: 15_000,
})
```

返回结构为 `{ source, sources }`。每个来源包含 `configured`、`selected`、`validity`、`expiresAt` 和可选的脱敏 `error`。选中优先级如下：

1. `config-token`：显式传入的 `token`。
2. `environment-token`：`FIGMA_TOKEN`。
3. `environment-oauth`：同时设置 `FIGMA_CLIENT_ID`、`FIGMA_CLIENT_SECRET`、`FIGMA_REFRESH_TOKEN`。
4. `local-oauth`：已保存的凭据。

没有配置凭据时，`source` 为 `none`。环境 OAuth 缺项且没有更高优先级 PAT 时，仍选中该无效来源，与正常认证的报错一致，不会静默回退。即使选中了其他来源，也会报告损坏的本地凭据文件。

| 有效性 | 含义 |
| --- | --- |
| `unknown` | 未检查，或检查无法确认凭据有效性；通过 `error` 区分文件访问、权限范围、限流和网络失败 |
| `valid` | 选中来源通过了本次网络检查 |
| `invalid` | 配置不完整、格式损坏，或凭据被明确拒绝 |
| `expired` | 已保存的本地 access token 过期 |

只有 `verify: true` 才请求网络，而且只检查选中来源。未传 `file` 时请求 `/v1/me`；传入 `file` 时通过 `depth=1` 发起最小文件请求。HTTP 401 标记为无效凭据；普通文件 HTTP 403 或 429 返回 `unknown` 并附带 HTTP 诊断，不能据此判定 token 无效。未选中来源不会进行网络验证，但本地可知的配置错误和过期状态仍会展示。

验证不会刷新本地 OAuth，包括已过期凭据，也不写入凭据或响应缓存。环境 OAuth 验证与正常同步共用同一身份的内存会话，在需要时刷新，并保留轮换后的凭据供后续同步使用。该会话未提供过期元数据，因此 `expiresAt` 仍为 `null`。刷新收到 HTTP 400、401 或 403 时标记为无效。网络刷新可能影响服务商当前生效的 token，因此跨进程共享授权的任务仍需协调。调用者取消时抛出 `IconctlAbortError`；其他检查失败放在选中来源的脱敏 `error` 中。宿主界面应将 `unknown` 与无效凭据区分展示。
