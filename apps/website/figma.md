# Figma conventions

Figma is one `iconctl` source. Designers maintain a library file, then press **Publish** in the [iconctl plugin](/publish). Engineering reviews the pull request. Figma Library “Publish” is only for other design files.

## File

Keep icons in a dedicated library file, not inside product screens.

## Frames

- One icon = one Component (or a variant inside a Component Set)
- 24×24 canvas unless you change `validate.width` / `validate.height`
- English kebab-case names: `arrow-left`, `user-filled`
- Chinese labels belong in the description, not the layer name
- Drafts start with `_` or `.` and are skipped

## Color

Monochrome icons only. The pipeline rewrites fills to `currentColor`.

## Config

```ts
{
  type: 'figma',
  file: 'https://www.figma.com/design/<fileKey>/Icons',
  pages: ['Icons'],
}
```

Publishing the Figma library is for other design files. Shipping icons into code is the plugin **Publish** button (or `iconctl sync` / the GitHub Action).

See the [demo](/demo) for a gallery built from the public [Lucide Icons](https://www.figma.com/community/file/939851755929765537/Lucide-Icons) library. Community URLs must be duplicated to a `/design/{fileKey}` link before the REST API will serve them.

## OAuth login and automatic renewal

Personal access tokens (`FIGMA_TOKEN`) require manual replacement. For automatic renewal, create an [OAuth app](https://www.figma.com/developers/apps), enable `file_content:read`, and register this exact redirect URL:

```text
http://127.0.0.1:53682/callback
```

A draft app is sufficient for its creator to test. Publish a private app to authorize other members of its team/organization; public apps require Figma review. See the [Figma OAuth documentation](https://developers.figma.com/docs/rest-api/oauth-apps/).

Supply the app credentials through your environment, then authorize once:

```bash
export FIGMA_CLIENT_ID='your-client-id'
export FIGMA_CLIENT_SECRET='your-client-secret'
pnpm exec iconctl auth figma login
unset FIGMA_CLIENT_ID FIGMA_CLIENT_SECRET FIGMA_REFRESH_TOKEN FIGMA_TOKEN
pnpm exec iconctl sync
```

`login` opens your system browser and waits up to five minutes. Use `--no-open` to open the printed URL yourself, or `--redirect-uri http://127.0.0.1:53683/callback` for another registered loopback address. The browser must reach the machine running the CLI. Login uses state validation and PKCE; it does not need an `iconctl.config.ts`.

```bash
pnpm exec iconctl auth figma status --json
pnpm exec iconctl auth figma logout
```

Credentials, including the client secret and refresh token, are saved in `$XDG_CONFIG_HOME/iconctl/figma.json`, falling back to `~/.config/iconctl/figma.json` (on Windows, `%APPDATA%/iconctl/figma.json`). The file is replaced atomically with owner-only permissions on POSIX. `ICONCTL_FIGMA_CREDENTIALS_FILE` can select another absolute path; keep it outside your repository and secure its parent directory. This is a credential file, not an encrypted keychain. Never commit it or upload it as a CI cache/artifact.

`sync` and `preview` refresh tokens within five minutes of expiry, and retry once after an explicit token rejection. Refreshes sharing a credential file are locked across processes. `status` only reports the credential source and expiry; `logout` removes the local file but does not revoke Figma authorization or clear environment variables. Revoke access in Figma when needed.

Authentication priority is source `token` → `FIGMA_TOKEN` → OAuth environment credentials → saved local credentials. Environment OAuth requires **all three** of `FIGMA_CLIENT_ID`, `FIGMA_CLIENT_SECRET`, and `FIGMA_REFRESH_TOKEN`; partial settings are errors. Unset login-only environment variables afterward to use the saved file. PAT authentication never refreshes automatically. `--dry-run` skips icon outputs but may update authentication and caches.

### GitHub Actions

Use an independent OAuth app or Figma account for CI. Figma keeps one active access token per app/user; a refresh invalidates the previous access token. Obtain the CI refresh token with `login`, using the CI app credentials and a separate `ICONCTL_FIGMA_CREDENTIALS_FILE` so you do not overwrite your local authorization.

Store the client ID, client secret, and the credential file's `refreshToken` value in GitHub Secrets. You can transfer the refresh token without printing it:

```bash
jq -r .refreshToken "$ICONCTL_FIGMA_CREDENTIALS_FILE" | gh secret set FIGMA_REFRESH_TOKEN --repo OWNER/REPO
```

The Action's `figma-client-id`, `figma-client-secret`, and `figma-refresh-token` inputs use these secrets. Each CLI process obtains an access token once and reuses it across sources. Tokens stay in memory in this mode; Secrets are not rewritten. Configure workflow concurrency as shown in [Distribute](/distribute), and serialize every job sharing an authorization. Repository concurrency does not coordinate separate repositories, so use separate authorizations there. No scheduled renewal job is needed.

## Private online console

For browser-based projects, OAuth renewal, snapshot review and npm publishing, see [console setup](./console).
