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

## npm publishing

Review added, changed and removed icons against the last successful snapshot. Choose patch/minor/major and inspect the actual package, version, icon count and digest before confirming. The first version is `0.1.0`.

Publishing reuses the confirmed immutable snapshot and tarball. It commits to `iconctl/<project-name>`, publishes public npm `latest`, and creates `<project-name>/v<version>` tags and GitHub Releases. External branch/version changes stop publishing. Lost callbacks are reconciled against registry `dist.integrity`; retries reuse the original tarball without refetching Figma.

For a new package, add `NPM_BOOTSTRAP_TOKEN` to the target repository's Actions Secrets. Use a granular npm token with the required package/automation permissions. Only publishing receives this token; the website never stores it.

After the package exists, configure its npm Trusted Publisher with the repository owner/name and `iconctl-console.yml`. **Explicitly allow direct `npm publish`**: new publishers may default to allowing only `npm stage publish`. Use GitHub-hosted runners, Node 24 and npm 11.5.1+. Remove the bootstrap secret once OIDC publishing is ready. Console project releases are separate from iconctl's monorepo release process.

## Figma plugin

Build with `pnpm --filter @iconctl/figma-plugin build`, then import `packages/figma-plugin/manifest.json` through Figma desktop **Plugins → Development → Import plugin from manifest**. The `dev` script rebuilds and inlines the UI when source files change.

Choose Private console → Connect console. Enter the five-minute pairing code in the authenticated console and select a project. The revocable device credential permits sync only for that project. Preflight errors or an empty icon page block submission. Rescan checks the current page again. The plugin shows a task link and result; release approval remains in the console.

Legacy GitHub dispatch remains supported. Its fine-grained PAT needs repository **Contents: read and write**, not Actions: write.

## Deployment and recovery

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
