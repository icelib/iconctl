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
    sprite: 'icons.svg', // Optional SVG symbol sprite
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

### SVG sprites

Optional `output.sprite: 'icons.svg'` writes a single SVG containing one `<symbol>` per resolved icon, variation or alias, sorted by name. IDs follow `iconctl-${prefix}-${name}`: `brand` + `home` becomes `iconctl-brand-home`. Each symbol has its own `viewBox`; resolved flips, rotations and processed colors, including `currentColor`, are preserved. Internal IDs are rewritten per symbol so gradients, masks and other local references do not collide.

Serve the generated file from the same origin as your app. A decorative icon can use:

```html
<svg width="24" height="24" aria-hidden="true">
  <use href="/icons.svg#iconctl-brand-home"></use>
</svg>
```

For inline use, insert the generated SVG once in the page and reference `#iconctl-brand-home`. This abbreviated example gives an informative icon an accessible name:

```html
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
  <symbol id="iconctl-brand-home" viewBox="0 0 24 24">
    <path fill="currentColor" d="M3 10 12 3l9 7v11h-6v-7H9v7H3Z"></path>
  </symbol>
</svg>
<svg width="24" height="24" role="img" aria-label="Home">
  <use href="#iconctl-brand-home"></use>
</svg>
```

Use `aria-hidden="true"` when adjacent text already conveys the meaning; use a meaningful `aria-label` with `role="img"` when the icon itself conveys information.

Sprite prefix, icon names and internal IDs must be nonempty ASCII strings matching `[A-Za-z0-9_.:-]+`; leading digits are allowed. Unsupported names fail explicitly rather than being renamed. The exporter supports local `href="#id"`, `xlink:href="#id"`, ARIA ID references and complete local `url(#id)` values, including quoted forms such as `url( '#id' )` and surrounding whitespace. Duplicate IDs, missing reference targets and URL fallback expressions are rejected.

The static format rejects residual CSS styles or stylesheets, SMIL animation, scripts, event attributes, `foreignObject`, external references and unsupported SVG elements. XML attributes may use single or double quotes; entities are decoded correctly and mixed text is retained. DTDs and processing instructions are rejected. These checks define the supported sprite format, not a complete SVG sanitizer. They apply to the processed SVG and cannot restore content removed during source cleanup.

The sprite joins JSON, individual SVGs, types, preview and changelog in the existing [output transaction](#sync-integrity-and-cancellation). Conflicting destinations fail before replacement. Its bytes also participate in the completion cache: a missing or edited sprite forces revalidation on the next sync even when remote metadata is unchanged. `output.types` includes resolved icon, variation and alias names as escaped TypeScript string literals.

`watch` updates the sprite after source edits and excludes it from change triggers. Keep `icons.svg` outside SVG source directories; source/output conflicts and symlink aliases are checked, and outputs cannot replace configuration or Iconify input files. `sync --dry-run` and `watch --dry-run` still validate the sprite's static format while skipping icon-output writes.

### JSON failures

Fatal failures from `sync`, `preview`, `diff`, `check` and `auth` with `--json` write one JSON report to stdout and exit with status 1. The CLI does not repeat the same error on stderr. For example, a sync validation failure includes the known source coordinates:

```json
{
  "success": false,
  "command": "sync",
  "error": {
    "name": "IconctlSyncError",
    "message": "Icon processing or validation failed: ...",
    "phase": "execution",
    "issues": [
      {
        "name": "arrow-left",
        "message": "Expected width 24, received 16",
        "stage": "validation",
        "sourceType": "figma",
        "sourceIndex": 0,
        "fileKey": "example-file",
        "nodeId": "12:34"
      }
    ]
  }
}
```

`error.phase` describes the known command boundary: `arguments` for invalid arguments or options, `configuration` for loading config, `authentication` for an `auth` operation, and `execution` for other command work. It does not guess the cause of an arbitrary error: credential or network failures thrown inside a sync remain `execution`. Per-icon `issues[].stage` describes that icon's import, processing or validation stage independently. Issues and source coordinates are omitted when unavailable; errors do not invent a diff or output files.

Successful JSON stays unchanged, including explicitly continued partial results. A valid `diff --check` comparison with changes still emits the normal diff report and exits 1; it is not a fatal error. Failed `check` reports retain their original top-level `prefix`, `count`, `source`, `valid` and `issues` and add `success`, `command` and `error`; `error.issues` contains the same issues as the top-level field. Consumers with strict schemas should allow these added failure fields. Fatal JSON previously left stdout empty for other commands; consumers can now parse the failure report.

`init --json` uses the same fatal report, but initialization remains interactive and has no successful JSON protocol. Watch keeps its separate NDJSON lifecycle described below. `--no-json` or `--json=false` selects human diagnostics. Library callers of `runCli()` still receive the original rejected error after it has been reported.

### Sync integrity and cancellation

`sync()` rejects individual Figma export-URL, SVG download/import, processing and validation failures before replacing outputs. Malformed directory SVGs, MasterGo entries and iconfont symbols are reported with the remaining source icons. `IconctlSyncError.issues` identifies the icon, failure stage, and source index, file key and Figma node ID when available. The CLI exits non-zero and preserves previous outputs by default.

Processing and validation issues follow the source that successfully supplied the final icon. `sourceIndex` is the zero-based position in `sources`; Figma issues also retain `fileKey` and `nodeId` after custom naming or same-name replacement. A later successful local source replaces that ownership and removes earlier Figma coordinates. A failed import keeps its own diagnostic without taking ownership of an earlier valid icon. These fields are available in thrown errors and continued or dry-run results. Caller-supplied `iconSet` values have no inferred source coordinates.

Use `continueOnError: true` (CLI: `--continue`) only when you want partial outputs. The result has `complete: false`, failure details in `failed` / `issues`, and `diff.deletionsReliable: false` with `removed: []`. It does not update the changelog or retain a complete-sync cache marker. Authentication failures, unreadable sources and a Figma source with no successfully imported icons still reject. The CLI prints warnings for partial results; `--json` exposes `complete`, `deletionsReliable`, `skipped` and `issues`. Explicitly requested partial success keeps a successful exit status.

After fixing a source or connection, run `sync` again. Without a valid complete-sync marker, sync refreshes the Figma document so a corrected file revision can be imported immediately. Completion markers record the validation rules version and fingerprints of all configured generated files, including SVGs, the SVG sprite and manifest, package files, types, preview and changelog. Missing or changed artifacts and older markers trigger a full check even when the remote file has not changed. Unrelated files in output directories do not invalidate completion. A changed changelog is preserved during revalidation; deleted history cannot be reconstructed from the current icons. Invalid SVG responses and incomplete image export responses are not reused from the download cache.

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

Legal nested outputs are prepared and committed together, including JSON package contents, SVGs, the SVG sprite, preview, types, changelog and cache metadata. Conflicting targets are rejected before replacement. A cleanup failure after commit emits an `ICONCTL_OUTPUT_CLEANUP` warning with residual directories; the committed sync still succeeds.

The SVG output directory contains an `.iconctl-manifest.json` that tracks generated SVGs, including aliases. Obsolete files are removed only when their names and contents still match the previous Iconify JSON and, when present, the manifest lists them. Manually edited obsolete SVGs and files whose ownership cannot be confirmed are retained; filenames generated by the current sync are still updated. Keep the manifest with the SVG output directory. The console runner excludes this internal manifest from publication artifacts.

When the Promise settles, work started by this call has settled and it performs no later output writes. Shared OAuth refresh and credential persistence are allowed to finish safely before a cancelled call rejects; another sync can keep using the renewed credentials. A custom authentication provider must also settle before cancellation completes.

This is not a cross-path atomic publish or crash-recovery protocol. Serialize syncs targeting the same paths. For strict atomic publication, configure all outputs in a separate versioned directory, then publish that directory or switch a pointer after success. `dryRun` still skips icon outputs while authentication and request caches may update.

### Local watch

For a config containing only local SVG folders or Iconify JSON files:

```bash
pnpm exec iconctl watch
pnpm exec iconctl watch --config ./iconctl.config.ts --dry-run --json
```

Watch supports `directory`, `jsdesign` with `dir`, `iconfont` with `dir` and no `url`, and `iconify` with a local `file`. Figma, MasterGo and remote iconfont URLs require a one-shot `sync`. There is no remote polling or preview server. `init` now defaults to `raw-svg` for source SVGs and `svg` for generated SVGs.

Native filesystem events are wake-up hints. A serialized metadata scan also repeats after a one-second idle interval, so missed notifications still converge to the current local inputs. The 150 ms debounce starts when a change is observed; this fallback does not poll remote sources. Changes during validation trigger another graph check before import, and repairs during a rejected check remain queued. Directory scans verify ancestor identities before descending and discard inconsistent samples. Rejected source links retain metadata checks on their bounded target chain, so repairing an external target can resume validation without editing the link. Stopping watch aborts new sampling and drains pending reads before `stopped`.

The watcher becomes ready before the initial sync. SVG or configured Iconify JSON additions, edits, deletions and source directory recreation trigger a sync after 150 ms of quiet. Runs are serial; changes during an import coalesce into a follow-up. Unrelated non-SVG files, hidden SVG source directories, generated outputs and caches do not trigger source syncs. As with `sync`, source directories may overlap.

Repeated discovery notifications and access-time changes without a new input version are ignored, including late symbolic-link discovery. Saving the main configuration with identical contents still reloads it; replacing a file or link still triggers the appropriate check.

Saving the main config or a local `extends` layer cancels the current run, waits for it to drain, loads a fresh configuration and rebuilds the watched paths. Configuration candidates and link chains are recorded before loading, then checked again before readiness; edits during the initial load or a newly added `extends` load trigger a fresh attempt. Local relative or absolute `extends` paths are supported. JavaScript, TypeScript and JSON helpers are reloaded with the configuration, including `.mjs`, `.cjs`, ESM `.js` and `createRequire()` imports. Arbitrary imported helper files are not watched: save the main config or restart watch after editing them. An invalid initial configuration is fatal. Later syntax errors, missing config files and unsupported sources pause syncing until the configuration is repaired; stale configuration is never reused to keep writing. Source import and validation errors are recoverable. `--continue` explicitly permits partial results, and `--dry-run` keeps its usual sync behavior.

Watch loads and runs each configuration version in its own Node.js worker. Source edits reuse that version, including its configuration functions, regular expressions and module state. A configuration reload disposes the previous worker and creates fresh module and package state. Module identity is shared inside one version; globals, package singletons and patches made by the calling process are not shared with it. `process.env` remains shared, `process.cwd()` follows the calling process, and `process.argv` is copied when the configuration loads. Node worker restrictions such as the absence of `process.chdir()` apply to configuration code. The separate `loadConfig()` and `sync()` APIs continue to run in the calling process.

Source roots must not contain, equal or sit inside generated SVG or JSON-package directories, or sit inside the cache. Config files must not be overwritten by any output or cache. A generated `.svg` file cannot live inside a source. Links and their targets are checked before listening and before each import to reject output/cache aliases and link cycles. Invalid initial link topology is fatal; links introduced later pause syncing until repaired. Valid external SVG and JSON targets remain watched, including target replacement and recreation. Use separate paths such as `raw-svg`, `svg` and `packages/icons`. JSON, TypeScript and HTML output files can be inside an SVG source, provided they do not replace a config or Iconify input file. Configured Iconify inputs cannot overlap any output file, generated directory or cache. The `ready.roots` event lists both SVG directories and Iconify files. Keep custom cache directories outside sources or hidden, because the importer traverses visible directories.

When a new external link changes the watched paths, its replacement listener becomes ready and links are checked again before importing. Links created during that startup are watched or rejected in the same run, even when no discovery notification arrives. Removing or repairing a rejected link resumes syncing without restarting watch.

If a source directory becomes a regular file while a listener is starting, watch finishes setup and reports a recoverable source error. Existing outputs are preserved, and recreating the directory resumes syncing through its parent observer. Cancellation also closes listeners that are still starting. This behavior is included in installed core and CLI packages.

Core supports both `import` and synchronous `require()` on Node.js 22.13 or newer. The CommonJS entry loads the same ESM implementation, including the bundled watcher fix; named exports and error classes share their identity across both entry points.

`--json` writes one compact object per stdout line: `ready`, `start`, `result`, `error` or `stopped`. Each run has an increasing `runId`; `start.reason` is `initial`, `source` or `config`. A `result` contains the same summary as `sync --json`, without SVG bodies. Errors contain only `name`, `message` and available `issues`. Human-readable output goes to stderr. Recoverable failures keep the process running; fatal failures exit 1. SIGINT and SIGTERM drain the current run, close watchers and exit 130 and 143 respectively.

```ts
import { IconctlAbortError, watch } from 'iconctl'

const controller = new AbortController()
try {
  await watch({
    cwd: process.cwd(),
    signal: controller.signal,
    onEvent(event) {
      if (event.type === 'result') console.log(event.result.diff)
    },
  })
}
catch (error) {
  if (!(error instanceof IconctlAbortError)) throw error
}
// Call controller.abort() from your application's shutdown handler.
```

The long-running Promise rejects with `IconctlAbortError` after cancellation cleanup and a `stopped` event. Once it settles, it performs no later writes. The existing sync commit boundary still applies: a commit already in progress finishes before configuration reload or shutdown continues.

### Check existing artifacts

Check a local Iconify collection directly, including in a folder with no iconctl configuration:

```bash
pnpm exec iconctl check --input ./icons.json
pnpm exec iconctl check --input ./icons.json --width 24 --height 24 --name '^[a-z0-9]+(-[a-z0-9]+)*$' --json
```

`--input` accepts a local file path and does not load or execute configuration, read configured sources, make network requests or write files. It cannot be combined with `--config`. The default name rule is kebab-case; dimensions are unrestricted unless `--width` or `--height` specifies a finite positive number. `--name` is a regular-expression source string, without slash delimiters or flags.

Without `--input`, `check` loads your configuration and inspects `output.svg` when configured, otherwise `output.json`; a missing configured SVG directory is an error. The same flags can override configured validation rules. This mode does not contact configured sources or generate outputs, although loading a user configuration executes its code.

JSON aliases count as named icons. Alias chains, flips, rotations and inherited geometry are resolved before checking the rendered canvas; Iconify's default canvas is 16×16 when dimensions are omitted. All names are checked, including hidden JSON icons and original SVG basenames in nested or hidden directories. Checks do not rename SVG files or apply source `skipPrefix` exclusions. Duplicate SVG basenames are errors.

`--json` writes one report with the existing `prefix`, `count` and `source` fields plus `valid` and `issues`. Failed reports also include the [JSON failure fields](#json-failures). Each issue has a `stage` (`options`, `read`, `import`, `process` or `validation`), a `message` and, when available, `name` and `file`. Import and SVG processing failures are retained alongside validation failures for the remaining icons. `count` includes discovered icons/aliases or SVG files, including failed ones. A report may have a null prefix or source if failure occurs before they can be determined. A failed check exits with status 1; a successful check exits with status 0. `--continue` does not turn a failed check into success.

The public API keeps the original successful result shape. Catch `IconctlCheckError` for structured diagnostics:

```ts
import { check, IconctlCheckError } from 'iconctl'

try {
  const result = await check({ input: './icons.json', validate: { width: 24, height: 24 } })
  console.log(result.prefix, result.count, result.source)
}
catch (error) {
  if (!(error instanceof IconctlCheckError)) throw error
  console.error(error.report, error.issues)
}
```

Existing `check({ config })` callers remain supported. API name rules also accept `RegExp`; global and sticky expressions start at index zero for every name without changing the caller's `lastIndex`.

### Preview a local collection

Generate a searchable, copyable HTML gallery directly from an existing Iconify JSON file:

```bash
pnpm exec iconctl preview --input ./icons.json
pnpm exec iconctl preview --input ./vendor/icons.json --output ./reports/vendor.html
pnpm exec iconctl preview --input ./icons.json --output ./reports/preview.html --dry-run --json
```

Local preview does not load or execute configuration, contact sources, access credentials or update caches. It writes only the requested HTML and any required parent directories. Input and output paths are relative to the current directory; the default output is `./preview.html`, even when the input is elsewhere. Paths must be local files: URLs, blank values, repeated path options and `-` for stdin/stdout are rejected. Real filenames with leading or trailing spaces are preserved.

`--output` requires `--input`. Local input cannot be combined with `--config` or `--continue`. Without `--input`, preview keeps the existing config-backed sync behavior, including `output.preview`, all configured outputs, source access, partial results and the sync JSON summary.

The local `--json` result contains absolute file paths and a count of all resolved icons and aliases, including hidden entries:

```json
{
  "input": { "file": "/project/icons.json", "prefix": "brand" },
  "count": 2,
  "outputFiles": ["/project/preview.html"]
}
```

Local `--dry-run` parses and renders the collection and checks the destination and input conflicts. It adds `dryRun: true` and returns `outputFiles: []`, without creating files, directories, staging areas or caches. Invalid JSON, dimensions, missing or cyclic aliases fail the whole operation and preserve existing HTML. Failures use the [common JSON error envelope](#json-failures) with `command: "preview"`; path options fail in `arguments`, while reading, collection resolution and output failures use `execution`.

Preview accepts a UTF-8 BOM and preserves custom names and SVG bodies while resolving inherited geometry and alias transforms for display. It does not optimize SVGs or enforce naming and canvas rules. Use `check --input` for SVG processing and validation. The HTML retains isolated SVG images, a fixed Content Security Policy and a complete static gallery when JavaScript is disabled.

Both `iconctl` and `@iconctl/core` export the render and write APIs:

```ts
import { renderPreviewHtml, writePreviewHtml, type WritePreviewHtmlOptions } from 'iconctl'

const html = renderPreviewHtml(iconsJson)
const options: WritePreviewHtmlOptions = { inputs: ['icons.json'] }
await writePreviewHtml('reports/preview.html', iconsJson, options)
```

The original two-argument writer remains supported. Pass `inputs` to protect source files, including hard links and directory or input symlink aliases; the CLI supplies its input automatically. Output leaf symlinks (including dangling links) and directories are rejected. The writer renders before staging, supports `dryRun: true`, and replaces the report through the same transaction used by `writeDiffHtml`. Serialize writes to the same destination. Rendering alone returns a string without writing files.

### Offline comparison

Compare two local Iconify JSON files without loading configuration, credentials or remote sources:

```bash
pnpm exec iconctl diff before.json after.json
pnpm exec iconctl diff before.json after.json --html reports/diff.html
pnpm exec iconctl diff before.json after.json --json --check
pnpm exec iconctl diff before.json after.json --html reports/diff.html --dry-run
```

The comparison includes icon names and aliases, resolves alias chains, inherited dimensions (16 × 16 when omitted), offsets, rotations and flips, and detects hidden-state changes. An alias and a concrete icon with the same resolved values are unchanged. Changing an alias parent also changes affected aliases. SVG bodies are compared as text after applying transforms; equivalent path syntax or differently optimized markup can still be reported as changed. This is not a pixel or geometric-equivalence comparison.

Prefix changes are reported independently: matching local names remain unchanged, while `prefixChanged` and `hasChanges` become true. `--check` exits 1 when an icon or prefix changes, after writing any requested report; without it, a valid comparison exits 0. Invalid JSON, dimensions, missing or cyclic aliases fail the entire comparison with exit 1 and preserve any previous report.

`--json` prints one object with `before` and `after` (absolute `file` and `prefix`), `prefixChanged`, `hasChanges`, sorted `added`, `removed`, `changed`, `unchanged` arrays, and `outputFiles`. This does not change `sync --json`. `--dry-run` performs the comparison and destination checks, reports `dryRun: true` and `outputFiles: []`, and creates no files, directories or caches.

The HTML report works offline with name search, change filters, counts and before/after images. It contains no external assets. Metadata is escaped, SVG bodies are isolated as image documents, and a Content Security Policy permits only the report's fixed script and styles. The ordinary `preview` gallery uses the same image isolation and alias rendering. A report cannot replace either input, including through a symlink or hard-link alias. Reports use staged replacement; serialize writes to the same destination.

The APIs are available from both `iconctl` and `@iconctl/core`:

```ts
import { compareIconSets, diffIconSets, renderDiffHtml, writeDiffHtml } from 'iconctl'

const comparison = compareIconSets(beforeJson, afterJson)
console.log(comparison.hasChanges, comparison.prefixChanged)
const html = renderDiffHtml(comparison)
await writeDiffHtml('reports/diff.html', comparison, {
  inputs: ['before.json', 'after.json'],
})
// Existing synchronous API keeps its four-array result shape.
const diff = diffIconSets(beforeJson, afterJson)
```

`compareIconSets(undefined, afterJson)` treats all icons as added. `writeDiffHtml` accepts `dryRun: true`; pass `inputs` when protecting source files in your own integration. The render function returns a string without writing files.

## 5. Use the JSON

With `@iconify/tailwind4` or UnoCSS, point a custom collection at `icons.json` and use `i-brand-arrow-left`. That class is a CSS mask, not a font.

Two ways to get the JSON to other developers: ship it **in the app repo**, or publish an **installable package**. See [Distribute](/distribute).

## Private online console

For browser-based projects, OAuth renewal, snapshot review and npm publishing, see [console setup](./console).
