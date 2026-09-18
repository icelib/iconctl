# Publish

Designer finishes icons, presses **Publish** in the Figma plugin, and engineering gets a pull request with Iconify JSON.

```
Figma plugin (preflight) → GitHub repository_dispatch
  → iconctl sync (FIGMA_TOKEN in Actions)
  → PR: icons.json + preview.html
  → developer reviews and merges
```

Figma Library “Publish” is still for other **design** files. This button is for **code**. Autosave is enough; the Action reads the file over REST.

## Engineering setup (once)

1. `iconctl.config.ts` in the app repo, Figma source pointing at the library file.
2. Copy `examples/github-publish.yml` to `.github/workflows/iconctl.yml`.
3. Repo secret `FIGMA_TOKEN` — a token that can **read** the library file.
4. Permissions on the workflow: `contents: write`, `pull-requests: write`.

## Designer setup (once)

1. `pnpm --filter @iconctl/figma-plugin build`
2. Figma → Plugins → Development → Import plugin from manifest → `packages/figma-plugin/manifest.json`
3. Plugin settings:
   - GitHub repo `owner/name`
   - Fine-grained PAT with **Actions: write** on that repo (not `FIGMA_TOKEN`)
   - Event type `iconctl-publish`

## Each release

1. Name components `arrow-left`, 24×24, drafts as `_…`
2. Open the plugin on the icon page → fix anything red
3. Publish
4. Open the Actions URL the plugin prints; the workflow opens `chore: sync icons`

Do not store a `contents:write` PAT in the plugin. The Action, not the plugin, writes the JSON.

After merge, developers get icons either from **git pull** (JSON in the app) or **`pnpm add`** (published package). Both are on [Distribute](/distribute).

## This repo

`packages/icons` (`@iconctl/icons`) is the worked example. Source is local SVG, not live Figma. Sync writes `icons.json`, `svg/`, `src/icon-names.ts`, `preview.html`, and `CHANGELOG.md`.

```bash
pnpm --filter @iconctl/icons sync
```

`.github/workflows/iconctl.yml` listens for `iconctl-publish` and `workflow_dispatch`, then opens a PR that only stages `packages/icons`. Point the Figma plugin at `icelib/iconctl` to exercise the same event (the workflow still will not call Figma).
