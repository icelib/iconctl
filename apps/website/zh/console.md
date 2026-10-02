# 私有线上控制台

[打开控制台](https://iconctl.icebreaker.top/app/)。公开文档不需要登录；控制台、业务 API 和产物下载仅向 GitHub 用户 ID `15621541`（sonofmagic）开放。

## 创建并安装 GitHub App

组织 Owner 打开 **组织 Settings → Developer settings → GitHub Apps → New GitHub App**。本项目使用 [icelib/iconctl-console](https://github.com/organizations/icelib/settings/apps/iconctl-console)。

- Homepage URL：`https://iconctl.icebreaker.top`
- Callback URL：`https://iconctl.icebreaker.top/api/auth/github/callback`
- Webhook URL：`https://iconctl.icebreaker.top/api/webhooks/github`
- Repository permissions：Contents、Actions、Pull requests、Workflows 均为 Read and write；Metadata 为 Read-only。
- Subscribe to events：Workflow run。
- 安装范围选择 Only on this account；创建后进入 **Install App → Install → Only select repositories**，只选择需要管理的仓库。

在 General 页面生成 Client secret 和 Private key。App ID、Client ID、Client secret、PEM 私钥分别写入 Worker Secrets：`GITHUB_APP_ID`、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_PRIVATE_KEY`。Webhook secret 使用独立随机值，同时填到 GitHub App 和 Worker 的 `GITHUB_WEBHOOK_SECRET`。

私钥用于签发 installation token；Client secret 用于网页登录，两者都需要。不要在网页保存 GitHub PAT，也不要把密钥提交到仓库。

## 连接 Figma / MasterGo

为站点创建独立的 Figma OAuth App，登记 HTTPS 回调：

```text
https://iconctl.icebreaker.top/api/auth/figma/callback
```

将 Client ID 和 Client secret 写入 Worker Secrets `FIGMA_CLIENT_ID` 和 `FIGMA_CLIENT_SECRET`。在「授权与插件」中点击「连接 Figma」，授权 `file_content:read`。本地 CLI、CI 和站点应使用不同 OAuth App 或账号。

access/refresh token 使用 AES-GCM 加密保存；独立的 `CREDENTIAL_ENCRYPTION_KEY` 为 32 个随机字节的 Base64。备份这个密钥，丢失后无法解密授权。浏览器只能查看状态。任务需要 token 时，距到期不足五分钟会续期；并发续期由 Durable Object 合并。Actions 通过 OIDC 只能领取当前任务来源的 access token，不会得到 client secret 或 refresh token。

断开后本地服务端凭据被删除；不代表 Figma 远端授权已撤销。刷新结果不确定或授权失效时，重新授权原连接。MasterGo 个人令牌同样加密保存，但不能自动续期。

## 项目与任务

1. 创建项目，填写已安装 App 的 GitHub 仓库、图标前缀和公开 npm 包名。
2. 添加 Figma、MasterGo、iconfont HTTPS Symbol URL、仓库 SVG 目录、仓库 Iconify JSON 文件或上传 SVG ZIP。即时设计使用导出 SVG。多个来源可以组合；后面的同名图标覆盖前面的图标。
3. 配置颜色、名称正则、尺寸、草稿前缀和输出选项。高级配置从固定 Git 提交读取 `iconNameForNode`，仅在 Actions 执行；来源、凭据、输出路径仍由任务固定。
4. 保存项目后，创建 runner 安装 PR，审查并合并到默认分支。控制台不会绕过分支保护。
5. 发起同步、仅校验、预览或 dry-run，在任务页面跟踪阶段、Actions 链接和快照。

上传限 10 MB ZIP，最多 5000 个 SVG，单个展开文件限 1 MB，总展开大小限 25 MB。拒绝绝对路径、目录穿越、非 SVG 文件及 SVG 来源中的符号链接。上传 ZIP 根目录在表单中使用 `svg`。图标以浏览器的 SVG image 模式展示；HTML 预览以附件下载，不在站点上下文执行。

**Dry run** 和「仅校验」记录检查快照，但不写图标产物、不更新成功基线，也不能直接发版。认证凭据仍可续期。每个任务固定配置版本、源码提交及执行器提交。同一项目的任务串行，工作流还设置仓库级 concurrency 和 `cancel-in-progress: false`。

### 仓库 Iconify JSON

选择「Iconify JSON」，填写相对仓库根目录的路径，例如 `vendor/icons.json`。runner 从任务固定的源码提交读取文件，对应配置为：

```json
{ "type": "iconify", "file": "vendor/icons.json", "include": ["home", "arrow-left"], "namePrefix": "vendor-" }
```

默认「全部图标」会导入图标和别名。「指定图标」每行填写一个精确名称，忽略空行；名单留空会保存 `include: []`，不导入任何图标。名称前缀按原文拼接：`vendor-` 得到 `vendor-home`，`vendor` 得到 `vendorhome`，不会转换大小写或自动加分隔符。项目的草稿前缀过滤、颜色处理、尺寸／名称校验和输出配置继续生效。别名、旋转和继承尺寸使用与 CLI 相同的核心导入流程。

此来源只读取仓库文件，无需来源凭据或上传。文件必须是普通文件，大小不超过 25 MiB。拒绝绝对路径、目录穿越、Git 元数据、目录和指向仓库外部的符号链接；允许最终指向仓库内普通文件的链接。runner 在加载高级配置前，将检查后的字节复制到任务目录。JSON 语法或集合结构错误归类为配置错误；选中图标的问题写入校验快照并阻止发布。

升级控制台后，先在各目标仓库创建并合并新版 runner 安装 PR，再启用此来源。工作流固定执行器提交，旧版固定 runner 不认识 `type: "iconify"`。

### 查找任务

在「任务与版本」中，组合任务状态、操作和关键词筛选当前项目的任务。关键词匹配任务 ID、源码 SHA、Actions run ID、当前阶段或错误，以及对应的展示文字。搜索忽略大小写和首尾空白，标点按字面匹配，例如 `[name]` 不会作为正则表达式执行。计数展示「匹配数 / 当前项目任务总数」，没有任务与没有匹配结果会分别提示。

自动轮询、点击「刷新状态」、打开快照后返回都会保留筛选条件。切换项目会清除条件；成功创建、重试或确认发布后，也会清除条件并聚焦返回的任务，因此可以看到它新的等待执行或运行中状态。操作被拒绝时保留条件。筛选不改变项目执行锁或已发布版本列表。

通过 `?job=...` 打开的链接会自动选择所属项目并聚焦任务一次，后续刷新不会重新抢占键盘焦点或项目选择。切换项目、视图或筛选后若隐藏了链接任务，可点击「定位链接任务」恢复所属项目并清除筛选。不可用的链接会显示错误。

筛选在浏览器中处理 `/api/state` 返回的完整任务列表，不会分页或减少 API 响应量。下文的 500 条上限针对单个任务的阶段历史，不限制任务数量。

### 失败重试

重试保留任务 ID 和历史事件，并开始新一次执行（attempt）。同步、仅校验、预览和 dry-run 的每次执行各自拥有独立快照。旧快照仍可查看，但新一次执行不能复用旧快照内容，也不能接受上一轮 runner 迟到的结果。同一次执行重复提交相同结果是安全的；提交不同结果会被拒绝。

旧快照没有 attempt 字段时按首次执行处理，旧格式的快照预留记录也只属于首次执行；无需迁移即可继续读取。Runner 请求格式保持兼容，服务端根据当前 attempt 和已领取任务的 GitHub workflow run 绑定结果。已经准备好发布产物的任务重试时，继续复用原先确认的快照、tarball 和提交。

### 按尝试查看历史与诊断

在「任务与版本 → 尝试与快照」中，查看每次尝试的阶段、错误、Actions 执行记录和不可变快照。重试后旧快照仍有入口，当前尝试显示在最前面。每个任务最多保留最近 500 条阶段事件；快照独立保存。发布重试复用已确认的快照，仍可通过任务结果中的「查看快照」打开。

快照诊断展示失败阶段、来源类型与序号，以及已记录的设计节点。Figma 问题同时包含文件与节点标识时，可以点击「在 Figma 中定位」。来源序号从 1 开始。问题计数与发布阻止条件保持原有语义。

旧快照缺少 `attempt` 时属于第一次尝试。没有尝试号的旧阶段事件单独列为「旧阶段记录（未记录尝试号）」，不推测归属。旧问题仍可读取，缺失的阶段或来源显示「未记录」。新增字段均可选，无需数据迁移或更改 runner 请求格式。结构化诊断需要任务固定的执行器提供相应字段；部署支持这些字段的执行器后，更新 runner 安装配置。

## 确认并发布

同步生成不可变快照。预览默认显示相对上次成功快照的新增、修改、删除及前后对比。将「比较基准」切换为「最近发布」，即可查看多次同步后相对已发布版本的累计变化；也可以选择同项目的任意快照。页面显示实际使用的基准，切换比较不会修改快照；校验问题会阻止发布。

选择 patch / minor / major 后，控制台显示实际包名、目标版本、图标数量、快照摘要，以及相对本次确认锁定的发布版本的累计新增、修改和删除。发布确认始终按发布基准计算，不受预览页所选基准影响。首次发布按空图标集比较，全部图标记为新增，版本为 `0.1.0`。准备确认期间若项目配置、发布版本发生变化，或有其他任务启动，需要重新审核；确认后的发布基准变化也会阻止提交。点击确认才创建发布任务；它复用这一快照和 npm tarball，不重新抓取 Figma。

产物提交到 `iconctl/<项目名>` 专用分支，公开发布到 npm `latest`，然后创建 `<项目名>/v<版本>` tag 和 GitHub Release。分支基线或版本发生外部变化时停止，不强推。npm 已成功但回调丢失时，alarm / webhook 对比 registry 的 `dist.integrity`，补齐记录。失败重试复用原 tarball；不要手工删除未对账的任务。

### npm 首次发布与可信发布

新包可在目标仓库配置 `NPM_BOOTSTRAP_TOKEN` Actions Secret：使用具备目标包发布权限的 npm granular token，按 npm 要求允许自动化发布。网站不保存这个 token，只有发布步骤能读取它。

包创建后，在 npm 包设置的 Trusted Publisher 中选择 GitHub Actions，填写目标 owner/repo 和工作流文件名 `iconctl-console.yml`。**明确启用直接 `npm publish` 权限**：新建 Trusted Publisher 的默认设置可能只允许 `npm stage publish`。使用 GitHub-hosted runner、Node 24、npm 11.5.1 以上。配置就绪后删除 `NPM_BOOTSTRAP_TOKEN`，后续使用 OIDC / provenance。

项目包与 iconctl 仓库本身的发布流程独立，不在这里修改 monorepo 包版本。

## Figma 插件

```bash
pnpm --filter @iconctl/figma-plugin build
```

Figma 桌面端：Plugins → Development → Import plugin from manifest，选择 `packages/figma-plugin/manifest.json`。开发时运行 `pnpm --filter @iconctl/figma-plugin dev`，源文件变化会重新构建并内联 UI。

在插件中选择 Private console，点击 Connect console。插件显示五分钟有效的配对码；登录网页后在「授权与插件」中输入配对码并选择项目。插件获得仅限该项目同步的凭据，可在网页撤销。当前页预检存在错误或没有可用图标时不能同步；Rescan 会重新检查。同步后显示任务链接和状态，最终发版仍在网页确认。

旧 GitHub dispatch 模式继续可用。Fine-grained PAT 需要目标仓库 **Contents: read and write** 权限（不是 Actions: write），用于 `repository_dispatch`。

## 部署、回滚与恢复

Console CI 工作流在 pull request 和 main 上使用 Linux、Node 24，依次构建控制台与 runner、检查类型、运行 runner/contracts 测试和独立的 Cloudflare Worker 测试，再通过 Chromium 验证浏览器流程。Worker 测试使用 console 自己的 Vitest 版本，不包含在根目录 `pnpm test` 的项目列表中。浏览器截图和失败 trace 会保留为工作流产物。

GitHub 登录与目录来源可先上线；未配置站点专用 Figma App 时，连接 Figma 会明确提示配置缺失。配置 `FIGMA_CLIENT_ID` 和 `FIGMA_CLIENT_SECRET` 后即可启用，无需填写占位凭据。

统一入口位于 `apps/console/wrangler.jsonc`。Vue 输出和 VitePress 文档合并到同一个 Worker，文档原 URL / 404 行为保持。原 website 的部署命令也转发到 console，避免静态站部署覆盖后端。

```bash
pnpm exec turbo run build --filter=@iconctl/console... --filter=@iconctl/console-runner...
pnpm --filter @iconctl/console exec wrangler r2 bucket create iconctl-console-production
# 使用仓库之外、权限为 0600 的 JSON 文件导入；内容包含上述八项 Secrets。
pnpm --filter @iconctl/console exec wrangler secret bulk /absolute/path/production.secrets.json --env ""
pnpm --filter @iconctl/console run deploy
```

部署要求改动已提交且提交已推送到 `origin/main`，执行器固定到该 SHA；脚本先执行 dry-run 再部署。GitHub 自动部署需配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` Secrets，并在初次接入验证后设置仓库变量 `ICONCTL_DEPLOY_ENABLED=true`。创建 GitHub production environment 可进一步管理部署访问。

仓库保留可选的独立 staging 配置（独立 DO 和 R2）。本实例按所有者选择直接使用 `iconctl.icebreaker.top`；真实 Figma OAuth 与 npm 发布仍需要完成提供方配置后验收。每次更新执行器后，目标仓库需重新创建并合并安装 PR。

```bash
pnpm --filter @iconctl/console exec wrangler versions list --env ""
pnpm --filter @iconctl/console exec wrangler rollback <previous-version-id> --env ""
```

在「授权与插件」下载加密管理数据备份，并使用具备 R2 访问权限的工具备份私有 bucket 的全部对象（含 snapshots、uploads、releases）。将加密密钥与备份分开保管。恢复时先停止派发任务，恢复到空的独立环境，使用同一加密密钥，在「授权与插件 → 恢复到空账户」导入管理备份并恢复 R2 原始对象 key，再核对快照摘要与 registry 完整性。旧 Figma 授权可能已旋转，恢复后重新授权；插件重新配对；未完成发布先对账。通过验证后切换绑定。不要将数据库回滚当作 npm 撤包。

### 插件项目预检与任务恢复

连接控制台后，Figma 插件使用项目配置的宽高、命名规则与草稿前缀；未设置的尺寸不受限制。高级命名 hook 仍由固定版本的 runner 校验，插件会明确提示。每次新同步前刷新规则；预检后配置发生变化时，需要检查新规则并再次点击同步。旧 GitHub 模式继续使用 24×24 预检。

点击预检结果旁的 **Locate**，即可在 Figma 画布选中并显示对应组件。两种连接模式都支持定位有错误的组件及组件集内的变体；被预检规则跳过的草稿不显示定位按钮。修正组件后点击 **Rescan** 更新结果。切换页面会禁用旧页面的定位按钮，重新扫描后恢复；组件已删除或移到其他页面时会提示重新扫描。定位只调整画布选区和视野，不修改组件内容或服务端配置的同步范围。

使用 **Search preflight** 搜索原始名称、最终图标名或问题文本，再用 **Problems only** 只看错误。搜索不区分大小写，按字面匹配，可与问题筛选叠加。列表显示匹配数与总数，**Clear filters** 恢复完整列表。筛选不改变检查或提交范围：被隐藏的错误仍会阻止同步。重新扫描会保留筛选条件；切换筛选会取消尚未完成的定位，当前扫描仍可用于定位可见行。

**Problems only** 会在关闭重开后恢复，搜索文字仅保留在当前会话。GitHub 设置和视图偏好分别恢复，不会覆盖已经编辑的字段。本地存储失败时可使用对应的 **Retry** 按钮，当前会话与任务状态仍可使用；重试保存会采用当前值。重新构建私有插件即可使用这些控件，无需更新服务端或迁移数据。

点击 **Export JSON report** 下载最近一次成功扫描的完整当前页报告，包含草稿、有错误的图标和被筛选隐藏的结果；空页面扫描也能导出。报告记录扫描时间、页面、原始名称与本地计算的图标名、节点 ID、尺寸、问题、汇总及实际使用的规则；已连接的扫描还包含项目名称和修订号。报告不包含设备凭据、GitHub 设置或任务状态，导出不会提交任务或上传内容。

报告仅表示当前页的本地预检，仍需服务端校验；使用服务端高级命名 hook 时，本地图标名是临时结果。重复导出保留同一次扫描的时间与内容；编辑组件后应重新扫描。切换页面或模式、变更项目连接以及扫描失败都会使旧报告失效。扫描失效后，也会暂停提交，直到新扫描成功。即使错误阻止提交，仍可导出报告；下载失败时可以显式重试，不改变筛选条件或工作流状态。重新构建插件即可使用，无需修改服务端或迁移存储数据。

插件会先保存提交标识再发送请求。关闭重开、响应丢失或断网恢复时，会恢复同一任务，不重复提交。轮询持续到服务端报告完成或失败，支持超过二十分钟的任务。断开或重新配对会结束旧的本地跟踪；在控制台撤销设备会同时收回服务端权限。任务链接自动选中所属项目并定位记录，无效链接会明确报错。

请先部署新版控制台，再更新插件。项目上下文接口仅返回项目展示信息、修订号及预检规则；服务端继续兼容旧插件，但旧插件无法执行新增的规则修订检查。
