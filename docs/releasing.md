# Release and website operations

The repository uses repoctl 6.0.1 with pnpm 12.6.0 and Node.js 24.22.1.
All publication workflows belong to `icelib/iconctl`.

## Stable packages and nightly

Create package release intent with `pnpm change`. The Release workflow prepares
a version PR, then publishes the merged version through its verified stages.
Keep the existing changeset ledger and pending intents. Package versions are
never edited manually.

Nightly runs from main every day at 02:00 Asia/Shanghai (18:00 UTC). To run it
manually, select **Release → Run workflow → main → mode: nightly**. Enable
`dry-run` for a publication plan without uploading packages.

```sh
pnpm dlx iconctl@snapshot-nightly --help
pnpm add @iconctl/core@snapshot-nightly
```

Nightly leaves the `latest` dist-tag and stable release intent unchanged. The
CLI uses the core package from the same snapshot. repoctl checks quality,
packed artifacts and independent consumers before reporting success. Stable
publication also runs the existing best-effort npmmirror synchronization hook.

Configure npm Trusted Publisher separately for `iconctl`, `@iconctl/core`, and
`@iconctl/icons`: GitHub owner `icelib`, repository `iconctl`, workflow filename
`release.yml`, with no environment restriction. Enable direct publishing for
this publisher. These packages already exist; no bootstrap publication is
required. Run **Release → mode: oidc-audit** before the first nightly. OIDC token
exchange alone does not prove that direct publishing is enabled.

For generated release PRs to trigger normal PR checks, configure
`REPOCTL_APP_CLIENT_ID` (variable) and `REPOCTL_APP_PRIVATE_KEY` (secret) for a
GitHub App with contents and pull-request write permissions. The release
workflow also supports `REPOCTL_RELEASE_TOKEN`; the auto-intent workflow uses
the App integration. Never commit publisher credentials.

## Preview and stable websites

The Documentation workflow updates the **documentation-only preview** on main
pushes. Its static Worker is `iconctl-docs-preview`; the deployment result
reports the actual account's workers.dev URL. Preview pages carry a preview
notice and are excluded from indexing. Links to the console open the formal
site. Preview has no production DO/R2 bindings or API.

The Release workflow deploys the **complete formal site** only after a stable
release completes. Its Worker remains `iconctl-docs`, serving
https://iconctl.icebreaker.top with `/app` and `/api`. It builds the frozen
release commit and pins the executor to that same commit. Private console
changes wait for the next covered package release.

Use these GitHub environments, restricted to the `main` branch. The stable
environment requires approval from `sonofmagic` before deployment:

| Environment | Required secret | Required variable or secret |
| --- | --- | --- |
| `docs-website-preview` | `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_ACCOUNT_ID` |
| `docs-website-stable` | `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_ACCOUNT_ID` |

Use a CI API token scoped to the deployment account with Workers Scripts Edit
and the account/zone access required for the existing custom-domain deployment.
The adapter also reads Worker deployments, versions and the workers.dev
subdomain to verify the result. Wrangler's local OAuth login is not a durable
GitHub Actions credential. Retain existing production Worker secrets and data
bindings; this migration does not provision or reset console data.

The `icelib` organization already shares `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `REPOCTL_APP_PRIVATE_KEY` and the
`REPOCTL_APP_CLIENT_ID` variable with this repository. Environment jobs inherit
these organization credentials; duplicate environment secrets are unnecessary.

The managed environments and concurrency groups are part of repoctl's deployment
contract. Keep their names and serialize each channel. The previous main-push
production workflow has been retired.

To retry an existing completed stable release, use **Documentation → Run
workflow → main**, site `website`, channel `stable`, and its completed release
ID. Preview retries use channel `preview` and the current main SHA. Start with
`repo docs plan` to inspect eligibility. `patchPaths` is empty: correction
commits cannot bypass the full release snapshot.

The internal `docs:build` and `docs:deploy:*` scripts are adapters called by
repoctl, not standalone production bypasses. Each deployment has a stable
identity. Only a provider-confirmed version receiving 100% of traffic records
success; retry the same failed workflow to recover a lost response. A newer
deployment must not be overwritten by an obsolete retry.

## Local validation

```sh
pnpm exec repo config validate --json
pnpm run repo:doctor --strict
pnpm exec repo check --full
pnpm tsd
pnpm test:package
pnpm --filter @iconctl/website test:channels
pnpm --filter @iconctl/console test:build
pnpm --filter @iconctl/console test:worker
```

For local Wrangler commands, `WRANGLER_HIDE_BANNER=true` avoids the npm update
check and `WRANGLER_SEND_METRICS=false` disables telemetry.

Snapshot planning uses `repo release snapshot --kind nightly --commit <HEAD>
--build-id <unique-identity> --dry-run --json`. Actual nightly publishing and
OIDC audit run in GitHub Actions. Website plans require main/release state;
stable plans remain ineligible until a covered stable release completes.
