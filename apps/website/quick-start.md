# Quick start

## 1. Install

```bash
pnpm add -D iconctl
```

## 2. Create a config

```bash
pnpm exec iconctl init
```

Or write `iconctl.config.ts` yourself:

```ts
import { defineConfig } from 'iconctl'

export default defineConfig({
  prefix: 'brand',
  sources: [
    {
      type: 'figma',
      file: 'https://www.figma.com/design/<fileKey>/Icons',
      pages: ['Icons'],
    },
  ],
  output: {
    json: 'icons.json',
    svg: 'svg',
    preview: 'preview.html',
  },
  validate: {
    width: 24,
    height: 24,
  },
})
```

A local folder is the zero-token path and produces the same Iconify JSON:

```ts
sources: [{ type: 'directory', dir: './raw-svg' }]
```

## 3. Token

For Figma, use [OAuth login and automatic renewal](/figma#oauth-login-and-automatic-renewal). After configuring your app, run `pnpm exec iconctl auth figma login`; subsequent syncs refresh tokens automatically. Directory sources need no credentials.

Alternatively, use a personal token, which requires manual replacement:

```bash
export FIGMA_TOKEN=figu_xxx
```

## 4. Sync

```bash
pnpm exec iconctl sync
```

CI:

```bash
pnpm exec iconctl sync --json
```

`--dry-run` skips icon outputs but may update authentication and caches. Validation errors exit non-zero and do not write a partial set.

### Sync integrity and cancellation

`sync()` rejects individual Figma export-URL, SVG download/import, processing and validation failures before replacing outputs. `IconctlSyncError.issues` identifies the icon, failure stage, and Figma source index, file key and node ID when available.

Use `continueOnError: true` (CLI: `--continue`) only when you want partial outputs. The result has `complete: false`, failure details in `failed` / `issues`, and `diff.deletionsReliable: false` with `removed: []`. It does not update the changelog or retain a complete-sync cache marker. A source-level request failure or a Figma source with no successfully imported icons still rejects. CLI JSON also exposes `complete` and `deletionsReliable`; explicitly requested partial success keeps a successful exit status.

```ts
import { IconctlAbortError, loadConfig, sync } from 'iconctl'

const config = await loadConfig()
const controller = new AbortController()
const task = sync({ config, signal: controller.signal })
// In your job cancellation handler: controller.abort()
try {
  const result = await task
  console.log(result.complete)
}
catch (error) {
  if (!(error instanceof IconctlAbortError)) throw error
  // Also identifiable by name === 'AbortError' and code === 'ABORT_ERR'.
}
```

Outputs are generated in temporary locations first. Cancellation before commit preserves the previous outputs and removes temporary artifacts. Requests receive the signal (combined with Figma's timeout), and processing yields between icons. An individual synchronous SVG operation or an already-started library export must finish before cancellation is observed. Once commit starts, cancellation is ignored: the call finishes committing and returns success. A commit I/O failure attempts rollback; if recovery fails, the error identifies retained backups.

When the Promise settles, work started by this call has settled and it performs no later output writes. Shared OAuth refresh and credential persistence are allowed to finish safely before a cancelled call rejects; another sync can keep using the renewed credentials. A custom authentication provider must also settle before cancellation completes.

This is not a cross-path atomic publish or crash-recovery protocol. Serialize syncs targeting the same paths. For strict atomic publication, configure all outputs in a separate versioned directory, then publish that directory or switch a pointer after success. `dryRun` still skips icon outputs while authentication and request caches may update.

## 5. Use the JSON

With `@iconify/tailwind4` or UnoCSS, point a custom collection at `icons.json` and use `i-brand-arrow-left`. That class is a CSS mask, not a font.

Two ways to get the JSON to other developers: ship it **in the app repo**, or publish an **installable package**. See [Distribute](/distribute).

## Private online console

For browser-based projects, OAuth renewal, snapshot review and npm publishing, see [console setup](./console).
