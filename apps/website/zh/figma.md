# Figma 约定

Figma 只是 `iconctl` 的一种来源。设计师维护 Library，然后在 [iconctl 插件](/zh/publish) 里点 **Publish**。工程侧 review PR。Figma 的 Publish Library 只给其他设计稿用。

## 文件

图标单独放在 Library 文件里，不要画在业务稿中。

## 画板

- 一图标一个 Component（或 Component Set 里的变体）
- 默认 24×24
- 英文 kebab-case：`arrow-left`、`user-filled`
- 中文写在描述里
- `_` 或 `.` 开头视为草稿

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
