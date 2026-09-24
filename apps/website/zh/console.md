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
2. 添加 Figma、MasterGo、iconfont HTTPS Symbol URL、仓库 SVG 目录或上传 SVG ZIP。即时设计使用导出 SVG。多个来源可以组合；后面的同名图标覆盖前面的图标。
3. 配置颜色、名称正则、尺寸、草稿前缀和输出选项。高级配置从固定 Git 提交读取 `iconNameForNode`，仅在 Actions 执行；来源、凭据、输出路径仍由任务固定。
4. 保存项目后，创建 runner 安装 PR，审查并合并到默认分支。控制台不会绕过分支保护。
5. 发起同步、仅校验、预览或 dry-run，在任务页面跟踪阶段、Actions 链接和快照。

上传限 10 MB ZIP，最多 5000 个 SVG，单个展开文件限 1 MB，总展开大小限 25 MB。拒绝绝对路径、目录穿越、非 SVG 文件及仓库源中的符号链接。上传 ZIP 根目录在表单中使用 `svg`。图标以浏览器的 SVG image 模式展示；HTML 预览以附件下载，不在站点上下文执行。

**Dry run** 和「仅校验」记录检查快照，但不写图标产物、不更新成功基线，也不能直接发版。认证凭据仍可续期。每个任务固定配置版本、源码提交及执行器提交。同一项目的任务串行，工作流还设置仓库级 concurrency 和 `cancel-in-progress: false`。

## 确认并发布

同步生成不可变快照。预览显示相对上次成功快照的新增、修改、删除及前后对比；校验问题会阻止发布。

选择 patch / minor / major 后，控制台显示实际包名、目标版本、图标数量和快照摘要。首次版本为 `0.1.0`。点击确认才创建发布任务；它复用这一快照和 npm tarball，不重新抓取 Figma。

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

GitHub 登录与目录来源可先上线；未配置站点专用 Figma App 时，连接 Figma 会明确提示配置缺失。配置 `FIGMA_CLIENT_ID` 和 `FIGMA_CLIENT_SECRET` 后即可启用，无需填写占位凭据。

统一入口位于 `apps/console/wrangler.jsonc`。Vue 输出和 VitePress 文档合并到同一个 Worker，文档原 URL / 404 行为保持。原 website 的部署命令也转发到 console，避免静态站部署覆盖后端。

```bash
pnpm exec turbo run build --filter=@iconctl/console... --filter=@iconctl/console-runner...
pnpm --filter @iconctl/console exec wrangler r2 bucket create iconctl-console-production
# 使用仓库之外、权限为 0600 的 JSON 文件导入；内容包含上述八项 Secrets。
pnpm --filter @iconctl/console exec wrangler secret bulk /absolute/path/production.secrets.json --env ""
pnpm --filter @iconctl/console deploy
```

部署要求改动已提交且提交已推送到 `origin/main`，执行器固定到该 SHA；脚本先执行 dry-run 再部署。GitHub 自动部署需配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` Secrets，并在初次接入验证后设置仓库变量 `ICONCTL_DEPLOY_ENABLED=true`。创建 GitHub production environment 可进一步管理部署访问。

仓库保留可选的独立 staging 配置（独立 DO 和 R2）。本实例按所有者选择直接使用 `iconctl.icebreaker.top`；真实 Figma OAuth 与 npm 发布仍需要完成提供方配置后验收。每次更新执行器后，目标仓库需重新创建并合并安装 PR。

```bash
pnpm --filter @iconctl/console exec wrangler versions list --env ""
pnpm --filter @iconctl/console exec wrangler rollback <previous-version-id> --env ""
```

在「授权与插件」下载加密管理数据备份，并使用具备 R2 访问权限的工具备份私有 bucket 的全部对象（含 snapshots、uploads、releases）。将加密密钥与备份分开保管。恢复时先停止派发任务，恢复到空的独立环境，使用同一加密密钥，在「授权与插件 → 恢复到空账户」导入管理备份并恢复 R2 原始对象 key，再核对快照摘要与 registry 完整性。旧 Figma 授权可能已旋转，恢复后重新授权；插件重新配对；未完成发布先对账。通过验证后切换绑定。不要将数据库回滚当作 npm 撤包。
