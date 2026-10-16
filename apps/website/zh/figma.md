# Figma 约定

Figma 只是 `iconctl` 的一种来源。设计师维护 Library，然后在 [iconctl 插件](/zh/publish) 里点 **Publish**。工程侧 review PR。Figma 的 Publish Library 只给其他设计稿用。

[Figma 插件的 Live preflight](/zh/console#figma-插件) 可在编辑后使用已加载项目规则重新预检当前页。每次会话需显式开启，不会自动提交或下载。


需要本地交接时，可使用 [Export SVG ZIP](/zh/console#导出原始-svg-交接包)，将当前页全部通过预检的组件导出为原始 SVG，配合 `directory` 来源与 `iconctl watch` 使用，无需 REST token 或远端任务。


插件新增 **Issue type**，可按命名、画布尺寸或重复名称集中审阅，并与搜索、Problems only 叠加。报告、SVG 交接与提交资格仍使用完整当前页扫描，详见[插件审阅控件](/zh/console#figma-插件)。

筛选旁的 **Sort components** 可按页面顺序、本地名称或 Figma 原始名称排列当前列表。空的本地名称放在最后；比较区分大小写，相同名称按原始名称、节点 ID 和捕获顺序稳定排列。排序只在本次会话有效并影响审阅、定位顺序，报告和同步仍使用完整扫描。


可用 [Copy visible names JSON](/zh/console#复制当前视图的本地名称) 将筛选后的本地预检名称复制为去重 JSON 数组。服务端 hook 名称仍是临时结果；剪贴板不可用时可手动选择复制。

使用 [Select visible components](/zh/console#选择当前可见组件) 可将筛选列表中最多 500 个组件设为画布选区，并保持缩放；不会修改节点或缩小报告与同步范围。

使用[复制当前视图的节点 ID](./console#复制当前视图的节点-id)，可把筛选组件交接为原文件 Figma 来源 `ids` 使用的 JSON 数组；本地名称不可用时仍可复制。切换复制内容不会中断正在进行的定位或批选。

## 文件

图标单独放在 Library 文件里，不要画在业务稿中。

## 画板

- 一图标一个 Component（或 Component Set 里的变体）
- 默认 24×24
- 英文 kebab-case：`arrow-left`、`user-filled`
- 中文写在描述里
- `_` 或 `.` 开头视为草稿

默认情况下，每个配置的 Figma 来源内，规范化后的名称必须唯一：`Arrow Left` 和 `arrow_left` 都会变成 `arrow-left`。自定义 `iconNameForNode` 也需要返回唯一的最终名称。冲突会报告每个相关节点，在替换产物前终止同步；可以重命名图层、调整命名函数，或显式启用下方命名策略。

使用 `--continue` 时，冲突组内所有图标都会被排除，其余有效图标可以生成不完整产物。如果没有任何有效图标，即使使用 `--continue` 也会失败并保留已有产物。冲突节点不会请求 SVG 导出。检查在页面和节点筛选后执行；不同配置来源之间原有的覆盖顺序保持不变。

## 重复图层的稳定名称

在 Figma 来源中显式开启以下策略，可以保留同名图层，并为后续名称追加稳定的节点 ID：

```ts
{
  type: 'figma',
  file: 'https://www.figma.com/design/<fileKey>/Icons',
  naming: {
    duplicates: 'suffix-node-id',
  },
}
```

例如，名称都是 `bell` 的节点 `34:1698` 和 `5398:44` 会得到 `bell`、`bell-5398-44`。没有已有映射时，按节点 ID 稳定排序决定原名称归属。分配后缀前会预留全部自然名称，再次冲突时追加 `-2`、`-3` 等编号。自动解决的冲突作为 warning 返回，不会让同步变成不完整结果。默认 `duplicates: 'error'` 继续使用上方严格规则。

此策略默认开启 `preserveNames: true`。同步成功后，映射保存到命令工作目录下的 `.iconctl-names.json`；根配置 `namingManifest` 可以指定其他本地路径。请将该文件与配置、产物一起纳入版本管理。归属由 Figma file key、`naming.namespace`（默认空字符串）和节点 ID 确定。同一文件使用不同命名规则时，应显式指定不同 namespace。

已有映射在图层重排、插入和改名后保持不变。删除节点仍保留其名称，恢复时取回原名称，其他节点不能接管。迁移公共名称时，需要显式审核并编辑 manifest 中的映射。manifest 损坏或保存了重复名称时会报错，不会静默重置归属。设置 `preserveNames: false` 则忽略已有映射，根据当前文档重新确定名称。

已有图标库首次启用此策略前，先检查节点与公共名称的对应关系：

```bash
pnpm exec iconctl preflight --json
pnpm exec iconctl sync --dry-run --json
```

Preflight 读取 Figma 文档，报告最终名称、冲突组、节点路径及 Figma 链接，不请求 SVG 导出，不写产物和命名 manifest，但可能刷新认证凭据、更新缓存。Dry-run 会执行完整处理流程并返回相同的命名计划，不提交产物和映射。需要同时检查 SVG 处理和校验时，使用 dry-run。

首次分配无法从旧 `icons.json` 推断节点归属。请将计划与已发布名称核对，必要时先补入 manifest 映射，再执行写入同步。[SDK 文档](/zh/sdk#figma-命名与预检)提供 manifest 结构示例。只有完整成功的同步才将 manifest 与产物原子提交；失败或部分同步保留原 manifest。

简单的自定义命名可使用 `naming.transform(name, node)`：它在默认节点和草稿筛选后执行，可返回 `null` 跳过节点，结果会先规范化再处理重复名称，无需复制默认过滤逻辑。已有 `iconNameForNode` 继续完整接管命名，也可搭配重复名称策略，但不能与 `naming.transform` 同时配置。

## 配置

```ts
{
  type: 'figma',
  file: 'https://www.figma.com/design/<fileKey>/Icons',
  pages: ['Icons'],
}
```

在 Figma 里 Publish Library 是给其他设计稿用的。进代码靠插件的 **Publish**（或 `iconctl sync` / GitHub Action）。

[演示页](/zh/demo) 用公开的 [Lucide Icons](https://www.figma.com/community/file/939851755929765537/Lucide-Icons) 库跑了一遍流水线。Community 链接要先复制成 `/design/{fileKey}`，REST API 才能读。

## OAuth 登录与自动续期

个人访问令牌 `FIGMA_TOKEN` 需要手动更换。要自动续期，先[创建 OAuth App](https://www.figma.com/developers/apps)，启用 `file_content:read` 权限，并登记以下完整回调地址：

```text
http://127.0.0.1:53682/callback
```

创建者可以测试草稿状态的 App；供团队或组织其他成员使用时，发布为私有 App。公开 App 需要 Figma 审核。详见 [Figma OAuth 文档](https://developers.figma.com/docs/rest-api/oauth-apps/)。

通过环境变量提供 App 凭据，完成一次浏览器授权：

```bash
export FIGMA_CLIENT_ID='your-client-id'
export FIGMA_CLIENT_SECRET='your-client-secret'
pnpm exec iconctl auth figma login
unset FIGMA_CLIENT_ID FIGMA_CLIENT_SECRET FIGMA_REFRESH_TOKEN FIGMA_TOKEN
pnpm exec iconctl sync
```

`login` 会打开系统浏览器，最多等待五分钟。使用 `--no-open` 可自行打开打印的链接；换端口时使用 `--redirect-uri http://127.0.0.1:53683/callback`，并在 App 中登记相同地址。浏览器必须能访问运行 CLI 的机器。登录使用 state 校验和 PKCE，不依赖 `iconctl.config.ts`。

```bash
pnpm exec iconctl auth figma status --json
pnpm exec iconctl auth figma logout
```

client secret、refresh token 等凭据保存在 `$XDG_CONFIG_HOME/iconctl/figma.json`，未设置时使用 `~/.config/iconctl/figma.json`；Windows 默认使用 `%APPDATA%/iconctl/figma.json`。文件原子替换，POSIX 系统下仅当前用户可读写。可以用 `ICONCTL_FIGMA_CREDENTIALS_FILE` 指定其他绝对路径，请放在仓库外并保护父目录权限。这是凭据文件，不是加密钥匙串，不能提交到 Git 或上传为 CI 缓存、制品。

`sync` 和 `preview` 会在距离过期不足五分钟时刷新，收到明确的 token 失效响应后最多刷新重试一次。同一凭据文件通过跨进程锁协调刷新。`status` 只显示凭据来源和到期状态；`logout` 只删除本地文件，不撤销 Figma 端授权，也不清除环境变量。需要撤销时请在 Figma 中操作。

凭据优先级为：来源配置中的 `token` → `FIGMA_TOKEN` → OAuth 环境变量 → 本地授权文件。环境变量模式必须同时提供 `FIGMA_CLIENT_ID`、`FIGMA_CLIENT_SECRET`、`FIGMA_REFRESH_TOKEN`，缺项会报错。登录后请取消仅用于登录的环境变量，以便使用保存的凭据。PAT 不会自动续期。`--dry-run` 不写图标产物，但可能更新认证凭据和缓存。

### GitHub Actions

CI 使用独立的 OAuth App 或 Figma 账号。Figma 对同一 App/用户只保留一个有效 access token，刷新会使旧令牌失效。使用 CI 的 App 凭据运行 `login` 获取 refresh token，同时通过 `ICONCTL_FIGMA_CREDENTIALS_FILE` 指定独立文件，避免覆盖本地授权。

把 client ID、client secret 和凭据文件中的 `refreshToken` 字段分别保存到 GitHub Secrets。可以不打印 refresh token，直接传入 Secret：

```bash
jq -r .refreshToken "$ICONCTL_FIGMA_CREDENTIALS_FILE" | gh secret set FIGMA_REFRESH_TOKEN --repo OWNER/REPO
```

Action 的 `figma-client-id`、`figma-client-secret`、`figma-refresh-token` 输入使用这些 Secrets。每次 CLI 进程启动获取一次 access token，多个来源复用；该模式仅在内存维护令牌，不回写 Secrets。按照[分发文档](/zh/distribute)设置 workflow concurrency，同一授权的任务必须串行。GitHub concurrency 不跨仓库协调，不同仓库请使用独立授权。无需增加定时续期任务。

## 私有线上控制台

需要在网页管理多项目、授权续期、快照审核和 npm 发布时，参阅[控制台接入](./console)。
