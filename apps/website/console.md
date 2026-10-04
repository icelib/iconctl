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

Create a project with an installed repository, icon prefix and public npm package name. Add Figma, MasterGo, iconfont HTTPS Symbol URLs, repository SVG directories, repository Iconify JSON files or uploaded SVG ZIP files. Jsdesign uses exported SVG. Multiple sources merge in order; later duplicate names win.

Configure naming, dimensions, color, draft prefixes and optional SVG/types/HTML/changelog outputs. Advanced `iconNameForNode` hooks load from a pinned repository commit and execute only in Actions. They cannot change job-bound sources, credentials or output paths.

Create and merge the runner installation PR on the default branch. Protected branches are never bypassed. Start sync, validation, preview or dry-run. Every task pins configuration revision, source SHA and executor SHA. Writes serialize per project; the workflow also uses repository concurrency with `cancel-in-progress: false`.

Uploads allow 10 MB compressed, 25 MB expanded, at most 5000 SVG files and 1 MB per SVG. Traversal paths, non-SVG entries and symlinks in SVG sources are rejected. Use `svg` to refer to the uploaded ZIP root. SVG comparisons use image rendering; HTML previews download as attachments rather than running in the application's origin.

ZIP uploads show their filename and status beside the source. One upload runs at a time; file selection and project saving stay disabled until it finishes or you choose **Cancel upload** (「取消上传」). A failed upload offers **Retry upload** (「重试上传」) for the same file, or you can select another file. Replacing an existing upload keeps the previous attachment until the new upload succeeds. Uploading does not save the project or run SVG validation; save the attached file and then run a task to validate its contents.

If you edit the ZIP subdirectory while uploading, completion keeps your input. Removing the source, restoring repository mode or leaving that editing session cancels the local upload operation; a late response cannot attach a file or show success in another editor. Canceling a navigation confirmation keeps the upload running in the original source. Canceling an upload does not delete a file that the server has already received. Files kept for retry exist only in the current editor's memory.

Dry-run and validation retain check snapshots but do not write icon outputs, update the successful baseline or permit release. Authentication credentials may still renew.

### Repository Iconify JSON

Choose **Iconify JSON** and enter a path relative to the repository root, such as `vendor/icons.json`. The runner reads the task's pinned source commit. A source may be configured as:

```json
{ "type": "iconify", "file": "vendor/icons.json", "include": ["home", "arrow-left"], "namePrefix": "vendor-" }
```

The default **All icons** imports icons and aliases. **Selected icons** accepts one exact name per line; blank lines are ignored, and leaving the list empty stores `include: []` and imports no icons. The name prefix is concatenated literally, so `vendor-` gives `vendor-home`, while `vendor` gives `vendorhome`. No case conversion or separator is added. Project draft-prefix filtering, color processing, dimension/name validation and output settings still apply. Aliases, rotations and inherited dimensions use the same core importer as the CLI.

This source uses only repository files and needs no source credentials or upload. Files must be regular files of at most 25 MiB. Absolute paths, traversal, Git metadata, directories and symlinks escaping the repository are rejected; links that resolve to a regular file inside the repository are allowed. The runner copies validated bytes into its task directory before loading advanced configuration. Invalid JSON or collection structure fails as a configuration error; invalid selected icons appear in the validation snapshot and prevent publication.

After upgrading the console, create and merge an updated runner installation PR in each target repository before selecting this source. The workflow pins its executor commit; older pinned runners do not recognize `type: "iconify"`.

### Recover workspace loading

If the first session or workspace read fails, use **Read workspace again** (「重新读取工作空间」) without reloading the page. Session setup is retried when it has not completed or an authentication failure has invalidated it. Project actions become available after the first successful workspace read. An expired login still opens the login page and stops automatic retries. If you cancel that navigation and sign in elsewhere, manual recovery first obtains the new session and CSRF token.

After loading, a failed refresh keeps the last displayed workspace and shows when it was read. The same retry action is available in every view. Recovery preserves your project, draft, task filters and keyboard focus; it never resubmits a save, task, device revocation or other successful write. A successful write always requires a fresh state read, so an older pending poll cannot restore the previous state.

Automatic reads run one at a time, normally 10 seconds after the previous attempt finishes. A session/state attempt times out after 30 seconds. Transient failures retry after 10, 20, 40 and at most 60 seconds; a successful read restores the normal cadence. Manual retry bypasses this delay. Automatic reads pause while the page is hidden or a mutation is pending; returning to the page or receiving a browser online event requests one catch-up read when eligible. Explicit post-save reads remain available. Leaving the console cancels its pending reads and timers; late responses cannot update a new session or send it to login.

### Save project configuration

Saving captures the current project's configuration and revision. You can keep typing or navigate while it is pending. Later edits remain marked as unsaved; a delayed result from another editing session updates the project list without changing your current project or draft. A newly created project adopts its server ID only in the original editor, so the next save updates it instead of creating it again.

Unsaved changes require confirmation before switching projects, leaving the editor, locating a task or logging out. **Keep editing** (「继续编辑」) or Escape keeps the whole draft and restores focus to the navigation control; **Discard changes and continue** (「放弃修改并继续」) applies the requested navigation. Clicking the active **Project configuration** navigation keeps the current draft, including a new project. A clean draft, or one reverted to its saved values, needs no confirmation.

A save may finish while the confirmation is open. The dialog then offers **Continue** (「继续前往」) if there are no later edits, but still waits for your choice. Leaving does not cancel an already submitted save or task. Successful tasks keep a **Locate task** link when revealing them would interrupt unsaved edits. Refreshing, closing the tab or following a link in the same tab uses the browser's standard unsaved-change prompt where supported; the prompt is removed after saving or reverting all changes. Drafts are held only in the current page and are not restored after leaving.

A successful save remains successful if refreshing the workspace fails. **Refresh workspace again** (「重新刷新工作空间」) retries the read only. When the server configuration changes or a save returns a conflict, your draft stays intact and saving requires explicit recovery: **Load latest configuration** (「载入最新配置」) replaces the draft after reading the latest state. An active task or a published project's identity restrictions may still prevent saving; recovery never retries the write automatically.

Saving rechecks the current configuration revision, task lock, source references and published identity after checking the repository. A sync or publication that finishes during that check keeps its latest snapshot and release pointers. Published projects cannot change their project name, package name or repository.

### Find a task

In **Tasks and versions** (「任务与版本」), combine status, operation and keyword filters for the current project. Keywords match task IDs, source SHAs, Actions run IDs, the current stage or error, and their displayed labels. Matching ignores case and surrounding whitespace; punctuation is literal, so `[name]` does not act as a regular expression. The count shows matching tasks / all tasks in the current project, with separate messages for an empty project and no matching results.

Polling, **Refresh status**, and opening a snapshot then returning keep your filters. Changing projects clears them. Successfully creating or retrying a task clears the filters and focuses the returned task while you remain in its original context and have no unsaved project edits. If you change projects, views or filters before the response arrives, or revealing the task would discard a draft, the task is recorded and **Locate task** (「定位任务」) lets you reveal it explicitly. Publication uses the same navigation behavior while its confirmation is active. A rejected action preserves your filters. Filtering does not change project execution locks or the published-version list.

A `?job=...` link selects the task's project and focuses its record once. Later updates leave keyboard focus and your selection alone. If you hide the linked task by switching projects, views or filters, **Locate linked task** (「定位链接任务」) restores its project and clears the filters. An unavailable link displays an error.

These filters run in the browser over the complete `/api/state` task list; they do not paginate tasks or reduce the API response. The 500-event limit below applies to each task's stage history, not the number of tasks.

### Task retries

Retrying a failed task keeps its task ID and event history and starts a new attempt. For sync, validation, preview and dry-run, each attempt owns a separate snapshot. Earlier snapshots remain available for review, but a new attempt cannot reuse their contents or accept a late result from an earlier runner. Repeated delivery of the same result within an attempt is safe; a different result for that attempt is rejected.

Existing snapshots without an attempt number and older snapshot reservations belong to the first attempt. They remain readable without a data migration. Runner request formats are unchanged: the server binds each result to the current attempt and its claimed GitHub workflow run. A prepared publication retry continues to use the original confirmed snapshot, tarball and commit.

### Attempt history and diagnostics

Open **Tasks and versions → Attempts and snapshots** (「任务与版本 → 尝试与快照」) to inspect each attempt's stages, error, GitHub Actions run and immutable snapshot. Retrying keeps earlier snapshots visible even after the current result changes. The current attempt appears first. Up to 500 recent stage events are retained per task; snapshot retention is independent. Publication retries reuse the confirmed snapshot, which remains accessible through the task's result button.

Snapshot diagnostics include the failing stage, source type and position, and design node when recorded. Figma issues with a file key and node ID provide an **Open in Figma** link. Source positions start at 1 in the UI. A snapshot's issue count and publishing checks are unchanged.

Older snapshots without `attempt` are shown under attempt 1. Older stage events without an attempt are listed separately as unassigned legacy records; their attempt is not guessed. Older issues remain readable and show unavailable metadata as unrecorded. These optional fields require no data migration or runner request changes. New metadata is available when the pinned executor emits structured issues; update the runner installation after deploying an executor that supports them.

### Trace a snapshot to its generating attempt

The **Snapshot origin** (「快照来源」) panel identifies the generating task, its operation and attempt, frozen project name, configuration revision, repository and source commit. These values belong to the task that produced the reviewed snapshot, even after the project is edited, the task is retried or a publication reuses that snapshot. Actions links come only from stage events explicitly assigned to that snapshot's attempt. If those events are missing or have been truncated, the panel says no corresponding execution link was recorded.

Choose **Locate generating task** (「定位生成任务」) to select its project, clear task filters, and open and focus the exact attempt in **Tasks and versions**. A retained first-attempt snapshot returns to attempt 1 even when the task has already succeeded on attempt 2. This focus happens once; later workspace refreshes preserve your focus and navigation. While a different snapshot is loading or fails to load, the source panel stays with the currently displayed review.

If the generating task is missing or belongs to a different project, the panel reports that the source task is unavailable. If only the current project is missing, the historical source remains visible and locating is disabled. The snapshot stays readable in both cases. Use **Reload workspace** (「重新读取工作空间」) to refresh the association. Legacy snapshots still mean attempt 1; unnumbered legacy events are never treated as evidence of a particular run. No API or persisted-data migration is required.

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

With default naming, two components on the current page that produce the same icon name (for example, `Arrow Left` and `arrow_left`) both receive a **Duplicate icon name** error. This includes component-set variants and blocks new submissions until you rename and rescan. Use **Problems only**, search, **Locate** and the complete JSON report to review every conflicting component. Skipped drafts do not participate. Custom server naming remains provisional and is not blocked based on local name collisions. The check covers only the current page; server validation is still required across the configured sync scope. Existing tasks continue to be tracked even when the current page has errors.

Use **Locate** next to a preflight result to select the component and bring it into view on the Figma canvas. This works for components with errors and component-set variants in both connection modes. Drafts excluded by the preflight rules have no Locate action. Correct the component, then choose **Rescan** to refresh its result. Changing pages disables the previous page's Locate actions until a rescan; deleted or moved components display a recovery message. Locating an icon changes only the canvas selection and viewport, leaving the configured server sync scope unchanged.

Use **Search preflight** to find node IDs, original names, final icon names or issue text, and **Problems only** to narrow the list to errors. Search is literal and case-insensitive; the filters combine. The list shows matching and total icon counts, and **Clear filters** restores the full list. Filtering never changes which icons are checked or submitted: a hidden error still blocks sync. Rescan preserves the view. Changing filters cancels a pending Locate without discarding the scan, so visible rows can still be located.

Enable **Live preflight** to recheck the current page while editing. The switch defaults to off and is never saved. A delivered page-edit event immediately makes the old scan unavailable for Locate, reports and submission; after 150ms without another edit, the whole page is checked with loaded rules. Search and Problems only remain, and the problem position resets with the new scan. This also catches nested additions/removals, component-set names, draft prefixes and duplicate names.

Live checks do not fetch rules, write settings, submit, dispatch or download anything. Existing task tracking continues. Rule reads pause live checks and manual Rescan; failed reads require **Refresh project rules**. A restored device whose rules could not be loaded stays unavailable instead of using unpaired defaults. Switching pages or modes keeps live checks enabled for the new context. Pairing, disconnecting, revoked credentials and closing the plugin turn them off. Turning the switch off cancels pending work without making stale results current; choose Rescan if needed. Scan failures recover on another edit or explicit Rescan. Server validation is still required, and previously downloaded reports remain historical snapshots.

Use **Previous problem** and **Next problem** to locate components with errors in the current filtered list. Each component counts once, even with several issues. Next starts at the first problem, Previous at the last, and both wrap at the ends. The position follows the latest location request; if a component was deleted or moved, continue to the next problem or rescan. A row’s **Locate** also sets the position when it has an error. Changing filters or rescanning resets the position. Paste a node ID from a JSON or HTML report into search to find that component; IDs are shown on each row. These controls also work with keyboard focus and Enter or Space, without changing task tracking or submission rules.

The plugin remembers **Problems only** across reopenings; search text lasts for the current session. GitHub settings and the view preference restore independently, preserving fields you have already edited. If local storage fails, use the relevant **Retry** button; the current session and task status remain usable. Retrying a save uses your current values. Rebuild the private plugin to use these controls; no server update or data migration is required.

Expand **Applied rules** to inspect the exact rules used by the current scan: project and revision, dimensions (or Unrestricted), naming pattern, skip prefixes and the server naming warning. An explicit empty prefix list is shown as None. The overview and exported report describe the same scan; GitHub and unpaired defaults are labelled separately.

When connected and idle, **Refresh project rules** reads the latest project context once and rescans the current page. It does not submit or resume a saved task, and keeps the task status and Open task link intact. Old results lose submission, export and navigation eligibility while rules are refreshing. After a failed read, use the same button to retry; Rescan or switching modes cannot revive stale project rules. A missing context (404) keeps the device association and task record so you can retry, while a revoked credential requires reconnecting. GitHub remains usable with its legacy defaults. Rule refresh is unavailable during pairing or task tracking; an overlapping request receives explicit busy feedback. Server validation is still required, including after a clean local scan.

Use **Export JSON report** to download the complete latest successful page scan, including drafts, invalid icons and results hidden by filters. An empty scan can also be exported. The report records the scan time, page, original and locally computed names, node IDs, dimensions, issues, summary and the rules used; connected scans include the project name and revision. It contains no device credentials, GitHub settings or task state. Exporting does not submit or upload anything.

Use **Export HTML report** for a standalone page you can read and print offline. It includes the same complete captured scan as JSON, with every component, draft, issue and applied rule. Use the browser’s Find to locate names or node IDs. The file has no scripts, external resources or embedded SVG, and component text is escaped. Both export formats keep the same scan timestamp and invalidation rules; exporting one temporarily disables both buttons, and a failed download can be retried. The plugin saves the file without opening a browser tab.

This is a local page preflight: server validation is still required, and names are provisional when a custom naming hook runs on the server. Repeated exports keep the same scan timestamp and content. Rescan after editing components; switching pages or modes, changing the project connection or a failed scan disables the old report. Invalidated scans also block submission until a new scan succeeds. Export is available even when errors block submission. A download failure offers an explicit retry without changing filters or workflow status. Rebuild the plugin to use reporting; no server changes or stored-data migration are needed.

Submission intent is saved before the network request. After closing and reopening the plugin, losing a response, or reconnecting to the network, it resumes the same task without another submission. Tracking continues until the server finishes, including tasks longer than twenty minutes. Disconnecting or pairing another device ends the previous local tracker; revoking the device also removes its server permissions. Task links select the owning project and highlight its record; unavailable links display an error.

Deploy the updated console before updating the plugin. The new context endpoint returns only project display information, revision and preflight rules. Older plugins remain compatible with the server, but cannot enforce the new preflight revision check.

Use **Download all SVG** (「下载全部 SVG」) in a snapshot's artifacts section to download its complete stored SVG set as one ZIP. Search, diff filters and the comparison baseline do not narrow the archive. Paths and bytes are preserved, including nested paths and names whose extraction depends on your operating system. The ZIP contains no HTML preview or other generated artifacts, and downloading does not run validation, fetch sources or publish a package. A failed snapshot can still provide its stored SVGs; its existing diagnostics and release restrictions remain.

Archives support snapshot documents up to 8 MiB, at most 5000 SVGs, 1 MiB per SVG and 5 MiB of SVG data in total. Files are stored without compression. Larger snapshots remain available through individual artifact downloads. Snapshots without stored SVG output, including check/dry-run results or SVG output being disabled, have no archive to download.

Download progress and errors stay in the snapshot review. An error can be retried by clicking the download button again. Changing the snapshot or comparison, switching projects or leaving the review cancels a pending download, so a late response cannot start a download for a different review. “Download started” means the browser received the download; it does not confirm that you saved the file.

## Export a raw SVG handoff

Choose **Export SVG ZIP** to deliver every non-draft component on the current page. The plugin first runs a fresh preflight with the loaded rules; search, Problems only and selection do not limit the export. Every icon must pass and every native export must succeed. Errors identify the affected node and keep the download empty; fix the issue and export again. Paired projects use their confirmed rules, while GitHub and unpaired mode use their existing defaults. Refresh unavailable project rules before retrying. Custom server naming hooks require a console sync: download the confirmed snapshot from the console instead.

The ZIP contains only `raw-svg/<icon-name>.svg`, with normalized component-set variant names. It contains raw Figma SVGs, before iconctl optimization, `currentColor` conversion or server naming. Figma exports the complete component bounds and outlines text, retaining the document color profile and default stroke simplification. Portable ASCII names are required; reserved names such as `con` and paths longer than 240 characters are refused rather than renamed. Limits are 5000 SVGs, 1 MiB per SVG, 5 MiB of SVG content and 8 MiB for the final ZIP. No partial archive is downloaded.

Extract the ZIP into a working directory and keep the input separate from generated output. For example, save this as `iconctl.config.ts` next to `raw-svg/`:

```ts
import { defineConfig } from '@iconctl/core'

export default defineConfig({
  prefix: 'design',
  sources: [{ type: 'directory', dir: 'raw-svg' }],
  output: {
    json: 'icons.json',
    svg: 'svg',
    types: 'icons.d.ts',
    preview: 'preview.html',
  },
})
```

```bash
pnpm exec iconctl sync --dry-run
pnpm exec iconctl watch
```

When receiving a replacement ZIP, replace only the owned input folder so removed icons do not remain there. Match any project-specific dimensions in the engineering config. The same SVG-only archive can be submitted to an existing runner ZIP source with `dir: 'raw-svg'`.

A temporary page-edit listener protects this export even when Live preflight is off. Received page edits, page/mode/project changes, manual Rescan, rule refresh, Cancel or closing the plugin discard the export. Figma's current native export cannot be interrupted: Cancel stops subsequent components and waits for the pending operation before permitting another export. This is event- and node-validated handoff, not an atomic Figma document snapshot. No network request, storage write, task creation or automatic sync is performed; current task tracking and separate feedback continue. Rebuild the plugin to use this button; no console upgrade or data migration is required.
