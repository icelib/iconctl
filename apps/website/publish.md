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
   - Fine-grained PAT with **Contents: write** on that repo (not `FIGMA_TOKEN`)
   - Event type `iconctl-publish`

## Each release

1. Name components `arrow-left`, 24×24, drafts as `_…`
2. Open the plugin on the icon page, choose **GitHub dispatch (legacy)**, then use **Locate** beside a red result to find its component. Fix it and choose **Rescan**.

   Default preflight also rejects duplicate normalized names on the current page. Both components are shown as errors; locate them, rename and rescan before dispatching. This does not prove uniqueness across other pages or server naming hooks.

   **Search preflight** matches original/final names and issue text; **Problems only** narrows the list to errors. Hidden errors still block dispatch. Filtering preserves workflow feedback, and rescanning preserves your filters. The problems-only preference is saved locally; search text is session-only. Settings restore without overwriting edits, and local storage failures offer a separate retry action.

   **Applied rules** shows the current dimensions, naming and draft rules. Use **Refresh project rules** while idle to update them without submitting a task; a failed read requires an explicit retry before console submission.

   **Export JSON report** or **Export HTML report** downloads the full latest page scan, including drafts and hidden errors, for offline review. HTML is a standalone readable, printable page with no scripts or external resources; use browser Find to locate a name or node ID. It includes rules and a fixed scan timestamp without credentials or workflow state. Export does not dispatch a task, and server validation is still required. See [complete preflight reports](./console#plugin-project-preflight-and-recovery).
3. Choose **Dispatch GitHub Action**
4. Open the Actions URL the plugin prints; the workflow opens `chore: sync icons`

Use the repository-scoped PAT above for dispatch. Keep `FIGMA_TOKEN` in Actions secrets; the Action reads the library and writes the JSON.

After merge, developers get icons either from **git pull** (JSON in the app) or **`pnpm add`** (published package). Both are on [Distribute](/distribute).

## This repo

`packages/icons` (`@iconctl/icons`) is the worked example. Source is local SVG in `raw/`, plus an optional iconfont Symbol URL. Sync writes `icons.json`, `svg/`, `src/icon-names.ts`, `preview.html`, and `CHANGELOG.md`. The [Demo](/demo) page previews the package and the changelog.

```bash
pnpm --filter @iconctl/icons sync
pnpm --filter @iconctl/icons add-iconfont -- https://at.alicdn.com/t/c/font_xxx.js
```

`.github/workflows/iconctl.yml` listens for `iconctl-publish` and `workflow_dispatch`, then opens a PR that only stages `packages/icons`. `workflow_dispatch` can pass an iconfont URL. Point the Figma plugin at `icelib/iconctl` to exercise the same event (the workflow still will not call Figma).

## Private online console

For browser-based projects, OAuth renewal, snapshot review and npm publishing, see [console setup](./console).
