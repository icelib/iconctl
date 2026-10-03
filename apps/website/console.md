# Private console

The [console](https://iconctl.icebreaker.top/app/) manages projects, snapshots and public npm releases. Documentation remains public. Login, API requests, previews and downloads allow only GitHub user ID `15621541` (sonofmagic).

## GitHub App setup

An organization owner creates an App under **Organization settings → Developer settings → GitHub Apps → New GitHub App**. This deployment uses `icelib/iconctl-console`.

- Homepage: `https://iconctl.icebreaker.top`
- Login callback: `https://iconctl.icebreaker.top/api/auth/github/callback`
- Webhook: `https://iconctl.icebreaker.top/api/webhooks/github`
- Repository permissions: Contents, Actions, Pull requests and Workflows **read and write**; Metadata read-only.
- Subscribe to Workflow run. Choose Only on this account.
- Open **Install App → Install → Only select repositories** and select the target repositories.

Generate a Client secret and PEM private key. Store `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` as Worker Secrets. Configure the same webhook secret on the App. The private key issues installation tokens; the client secret completes user login. The browser never stores a GitHub PAT.

## Source authorization

Create a separate Figma OAuth App for the website. Register `https://iconctl.icebreaker.top/api/auth/figma/callback`, then set Worker Secrets `FIGMA_CLIENT_ID` and `FIGMA_CLIENT_SECRET`. Connect Figma from the console, granting `file_content:read`. Use separate authorizations for local CLI, CI and the website.

Set `CREDENTIAL_ENCRYPTION_KEY` to 32 cryptographically random bytes encoded as Base64. Access and refresh tokens are encrypted with AES-GCM. Back up this key separately: losing it makes stored authorizations unreadable.

The owner Durable Object refreshes access tokens on demand within five minutes of expiry and combines concurrent requests. A runner obtains only task-scoped access tokens through verified GitHub OIDC; refresh tokens and client secrets stay on the server. Uncertain rotating refreshes require reconnecting. Disconnecting deletes server credentials; it does not revoke the provider's remote grant. MasterGo PATs are encrypted too, but require manual replacement when expired.

## Project workflow

Create a project with an installed repository, icon prefix and public npm package name. Add Figma, MasterGo, iconfont HTTPS Symbol URLs, repository SVG directories or uploaded SVG ZIP files. Jsdesign uses exported SVG. Multiple sources merge in order; later duplicate names win.

Configure naming, dimensions, color, draft prefixes and optional SVG/types/HTML/changelog outputs. Advanced `iconNameForNode` hooks load from a pinned repository commit and execute only in Actions. They cannot change job-bound sources, credentials or output paths.

Create and merge the runner installation PR on the default branch. Protected branches are never bypassed. Start sync, validation, preview or dry-run. Every task pins configuration revision, source SHA and executor SHA. Writes serialize per project; the workflow also uses repository concurrency with `cancel-in-progress: false`.

Uploads allow 10 MB compressed, 25 MB expanded, at most 5000 SVG files and 1 MB per SVG. Traversal paths, non-SVG entries and repository symlinks are rejected. Use `svg` to refer to the uploaded ZIP root. SVG comparisons use image rendering; HTML previews download as attachments rather than running in the application's origin.

Dry-run and validation retain check snapshots but do not write icon outputs, update the successful baseline or permit release. Authentication credentials may still renew.

### Save project configuration

Saving captures the current project's configuration and revision. You can keep typing or navigate while it is pending. Later edits remain marked as unsaved; a delayed result from another editing session updates the project list without changing your current project or draft. A newly created project adopts its server ID only in the original editor, so the next save updates it instead of creating it again.

A successful save remains successful if refreshing the workspace fails. **Refresh workspace again** (「重新刷新工作空间」) retries the read only. When the server configuration changes or a save returns a conflict, your draft stays intact and saving requires explicit recovery: **Load latest configuration** (「载入最新配置」) replaces the draft after reading the latest state. An active task or a published project's identity restrictions may still prevent saving; recovery never retries the write automatically.

Saving rechecks the current configuration revision, task lock, source references and published identity after checking the repository. A sync or publication that finishes during that check keeps its latest snapshot and release pointers. Published projects cannot change their project name, package name or repository.

### Find a task

In **Tasks and versions** (「任务与版本」), combine status, operation and keyword filters for the current project. Keywords match task IDs, source SHAs, Actions run IDs, the current stage or error, and their displayed labels. Matching ignores case and surrounding whitespace; punctuation is literal, so `[name]` does not act as a regular expression. The count shows matching tasks / all tasks in the current project, with separate messages for an empty project and no matching results.

Polling, **Refresh status**, and opening a snapshot then returning keep your filters. Changing projects clears them. Successfully creating or retrying a task clears the filters and focuses the returned task while you remain in its original context. If you change projects, views or filters before the response arrives, the task is recorded and **Locate task** (「定位任务」) lets you reveal it explicitly. Publication uses the same navigation behavior while its confirmation is active. A rejected action preserves your filters. Filtering does not change project execution locks or the published-version list.

A `?job=...` link selects the task's project and focuses its record once. Later updates leave keyboard focus and your selection alone. If you hide the linked task by switching projects, views or filters, **Locate linked task** (「定位链接任务」) restores its project and clears the filters. An unavailable link displays an error.

These filters run in the browser over the complete `/api/state` task list; they do not paginate tasks or reduce the API response. The 500-event limit below applies to each task's stage history, not the number of tasks.

### Task retries

Retrying a failed task keeps its task ID and event history and starts a new attempt. For sync, validation, preview and dry-run, each attempt owns a separate snapshot. Earlier snapshots remain available for review, but a new attempt cannot reuse their contents or accept a late result from an earlier runner. Repeated delivery of the same result within an attempt is safe; a different result for that attempt is rejected.

Existing snapshots without an attempt number and older snapshot reservations belong to the first attempt. They remain readable without a data migration. Runner request formats are unchanged: the server binds each result to the current attempt and its claimed GitHub workflow run. A prepared publication retry continues to use the original confirmed snapshot, tarball and commit.

### Attempt history and diagnostics

Open **Tasks and versions → Attempts and snapshots** (「任务与版本 → 尝试与快照」) to inspect each attempt's stages, error, GitHub Actions run and immutable snapshot. Retrying keeps earlier snapshots visible even after the current result changes. The current attempt appears first. Up to 500 recent stage events are retained per task; snapshot retention is independent. Publication retries reuse the confirmed snapshot, which remains accessible through the task's result button.

Snapshot diagnostics include the failing stage, source type and position, and design node when recorded. Figma issues with a file key and node ID provide an **Open in Figma** link. Source positions start at 1 in the UI. A snapshot's issue count and publishing checks are unchanged.

Older snapshots without `attempt` are shown under attempt 1. Older stage events without an attempt are listed separately as unassigned legacy records; their attempt is not guessed. Older issues remain readable and show unavailable metadata as unrecorded. These optional fields require no data migration or runner request changes. New metadata is available when the pinned executor emits structured issues; update the runner installation after deploying an executor that supports them.

## npm publishing

Review added, changed and removed icons against the last successful snapshot by default. Select **Latest release** to review all changes since publication, including changes made across several syncs, or choose any snapshot from the same project. The preview identifies the actual comparison baseline; choosing a different baseline never modifies a snapshot.

Only your latest snapshot or comparison selection can update the review. While it loads, the previous snapshot, comparison and downloads remain together, and publication is disabled. A failed request preserves that review and shows a local retry message. Changing projects or leaving the review cancels pending reads; a late response cannot return you to the old project.

Choose patch/minor/major and inspect the actual package, version, icon count and digest before confirming. The confirmation always shows cumulative additions, changes and removals against the published version it locks, regardless of the preview's selected baseline. For the first release, every icon is an addition against an empty set and the version is `0.1.0`. Configuration changes, a new release or an active task while preparing the confirmation require a fresh review. A changed publication baseline also invalidates an existing confirmation.

Publication errors appear inside the confirmation dialog. For an expired, missing or stale confirmation, choose **Get a new confirmation** (「重新获取发布确认」), inspect the new version and changes, then confirm again. Refreshing never starts publication. If the project configuration changed, select a new compatible sync snapshot before requesting another confirmation. After a network or gateway failure, **Retry publication request** (「重试发布请求」) reuses the same confirmation and idempotency key, so an already created task is returned without creating another. You can close a pending dialog; a later successful response records the task and offers **Locate publication task**, without changing your current project or view.

Publishing reuses the confirmed immutable snapshot and tarball. It commits to `iconctl/<project-name>`, publishes public npm `latest`, and creates `<project-name>/v<version>` tags and GitHub Releases. External branch/version changes stop publishing. Lost callbacks are reconciled against registry `dist.integrity`; retries reuse the original tarball without refetching Figma.

For a new package, add `NPM_BOOTSTRAP_TOKEN` to the target repository's Actions Secrets. Use a granular npm token with the required package/automation permissions. Only publishing receives this token; the website never stores it.

After the package exists, configure its npm Trusted Publisher with the repository owner/name and `iconctl-console.yml`. **Explicitly allow direct `npm publish`**: new publishers may default to allowing only `npm stage publish`. Use GitHub-hosted runners, Node 24 and npm 11.5.1+. Remove the bootstrap secret once OIDC publishing is ready. Console project releases are separate from iconctl's monorepo release process.

## Figma plugin

Build with `pnpm --filter @iconctl/figma-plugin build`, then import `packages/figma-plugin/manifest.json` through Figma desktop **Plugins → Development → Import plugin from manifest**. The `dev` script rebuilds and inlines the UI when source files change.

Choose Private console → Connect console. Enter the five-minute pairing code in the authenticated console and select a project. The revocable device credential permits sync only for that project. Preflight errors or an empty icon page block submission. Rescan checks the current page again. The plugin shows a task link and result; release approval remains in the console.

Legacy GitHub dispatch remains supported. Its fine-grained PAT needs repository **Contents: read and write**, not Actions: write.

## Deployment and recovery

The Console CI workflow runs on pull requests and main with Linux and Node 24. It builds the console and runner, checks types, runs runner/contracts tests and the separate Cloudflare Worker tests, then exercises browser flows in Chromium. The Worker tests use the console's Vitest version; they are not included in the root `pnpm test` project list. Browser screenshots and failure traces are retained as workflow artifacts.

`apps/console/wrangler.jsonc` is the single deployment entry. It merges Vue and VitePress assets, preserving documentation URLs and 404 behavior. The old website deploy command forwards to the console.

```bash
pnpm exec turbo run build --filter=@iconctl/console... --filter=@iconctl/console-runner...
pnpm --filter @iconctl/console exec wrangler r2 bucket create iconctl-console-production
pnpm --filter @iconctl/console exec wrangler secret bulk /absolute/path/production.secrets.json --env ""
pnpm --filter @iconctl/console run deploy
```

Keep the secrets JSON outside the repository with mode 0600. Deployment requires committed changes pushed to `origin/main`; it pins the executor SHA and runs a dry run first. Automatic deployment requires repository Secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` and variable `ICONCTL_DEPLOY_ENABLED=true` after initial validation. Updating the executor requires merging an updated installation PR in each target repository.

An optional staging configuration isolates DO and R2 storage. This instance's owner selected direct deployment to the production domain. Real Figma authorization and npm publication still need provider configuration and live acceptance checks.

Use `wrangler versions list` and `wrangler rollback <version-id>` to roll back Worker code. Export encrypted metadata in the console and back up the entire private R2 bucket separately. Preserve the encryption key separately. Restore into an empty isolated environment with the original object keys, verify snapshot digests and npm integrity, reconnect rotated authorizations and re-pair plugins. Reconcile pending npm publications before enabling dispatch. Restoring the database cannot undo npm publication.

### Plugin project preflight and recovery

Console-connected Figma plugins use the project's width, height, naming pattern and draft prefixes. Omitted dimensions are unrestricted; custom naming hooks remain server-side checks. The plugin refreshes these rules before a new sync, and a concurrent configuration update requires a fresh preflight. The legacy GitHub mode still checks 24×24 icons.

Use **Locate** next to a preflight result to select the component and bring it into view on the Figma canvas. This works for components with errors and component-set variants in both connection modes. Drafts excluded by the preflight rules have no Locate action. Correct the component, then choose **Rescan** to refresh its result. Changing pages disables the previous page's Locate actions until a rescan; deleted or moved components display a recovery message. Locating an icon changes only the canvas selection and viewport, leaving the configured server sync scope unchanged.

Submission intent is saved before the network request. After closing and reopening the plugin, losing a response, or reconnecting to the network, it resumes the same task without another submission. Tracking continues until the server finishes, including tasks longer than twenty minutes. Disconnecting or pairing another device ends the previous local tracker; revoking the device also removes its server permissions. Task links select the owning project and highlight its record; unavailable links display an error.

Deploy the updated console before updating the plugin. The new context endpoint returns only project display information, revision and preflight rules. Older plugins remain compatible with the server, but cannot enforce the new preflight revision check.
