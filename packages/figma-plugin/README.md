# iconctl Publish (Figma plugin)

Designer button: preflight this page’s components, then kick `iconctl-publish` on GitHub so Actions can sync Iconify JSON and open a PR.

## Load in Figma

```bash
pnpm --filter @iconctl/figma-plugin build
```

In Figma: **Plugins → Development → Import plugin from manifest…** and pick `packages/figma-plugin/manifest.json`.

## Settings

- GitHub repo `owner/name`
- Fine-grained PAT with **Contents: read and write** on that repo (not `FIGMA_TOKEN`)
- Event type `iconctl-publish` (must match the workflow)

The product repo needs `FIGMA_TOKEN` as an Actions secret and a copy of `examples/github-publish.yml`.

## Private console mode

Choose Private console and connect with a five-minute pairing code. Approve the code and project in the authenticated web console. The plugin can trigger sync only; publishing must be confirmed on the website. Errors in preflight block submission. Revoke devices from the console. See [setup](../../apps/website/console.md).

`pnpm --filter @iconctl/figma-plugin dev` rebuilds JavaScript and re-inlines the UI after source changes.

## Project rules and task recovery

Console mode loads the paired project's dimensions, naming pattern and draft prefixes. An omitted dimension is unrestricted. Custom naming hooks run only in the pinned runner; the plugin marks name validation as deferred. GitHub mode keeps its existing 24×24 preflight.

The plugin saves a submission ID before sending it. Reopening the plugin or recovering a lost response reuses that request and resumes the existing task. Only one task is tracked at a time; transient failures retry with backoff until the server reports a terminal state. Changed rules require a refreshed preflight and another explicit sync. Disconnecting stops local tracking; revoke the device in the console to invalidate its credential.

New plugins require the project-context endpoint. Upgrade the console first; the console continues accepting older plugins without a revision field. Task links open the owning project in the console.

## Find and navigate problems

Enable **Live preflight** to recheck the current page while editing. The switch defaults to off and is never saved. A delivered page-edit event immediately makes the old scan unavailable for Locate, reports and submission; after 150ms without another edit, the whole page is checked with loaded rules. Search, Problems only and Issue type remain, and the problem position resets with the new scan. This also catches nested additions/removals, component-set names, draft prefixes and duplicate names.

Live checks do not fetch rules, write settings, submit, dispatch or download anything. Existing task tracking continues. Rule reads pause live checks and manual Rescan; failed reads require **Refresh project rules**. A restored device whose rules could not be loaded stays unavailable instead of using unpaired defaults. Switching pages or modes keeps live checks enabled for the new context. Pairing, disconnecting, revoked credentials and closing the plugin turn them off. Turning the switch off cancels pending work without making stale results current; choose Rescan if needed. Scan failures recover on another edit or explicit Rescan. Server validation is still required, and previously downloaded reports remain historical snapshots.

Use **Previous problem** and **Next problem** to locate components with errors in the current filtered list. Each component counts once, even with several issues. Next starts at the first problem, Previous at the last, and both wrap at the ends. The position follows the latest location request; if a component was deleted or moved, continue to the next problem or rescan. A row’s **Locate** also sets the position when it has an error. Changing filters or rescanning resets the position. Paste a node ID from a JSON or HTML report into search to find that component; IDs are shown on each row. These controls also work with keyboard focus and Enter or Space, without changing task tracking or submission rules.

Search is literal and case-insensitive across node IDs, original/final names and issues. Skipped drafts stay outside the list. Filtering to a healthy component keeps its ordinary Locate available; hidden errors still block submission. Refreshing project rules, switching pages or modes, disconnecting or closing the plugin cancels old navigation and requires a current scan.


Use **Issue type** to focus on Naming, Canvas size or Duplicate names. It combines with search and Problems only; All issue types keeps healthy components visible when Problems only is off. Counts show components from the complete scan, before any filter. A component with several issues can appear in more than one category, but counts only once within each category. Skipped drafts are excluded. **Other** contains issues from older plugins, unknown diagnostic codes or incomplete classification metadata; the original issue text stays visible.

The selected issue type lasts for this session and survives Rescan and Live preflight. If the selected category has no matches, it remains selected with an empty view, including Other after its last issue is resolved. **Clear filters** resets search, Problems only and issue type. Changing the category cancels pending Locate and resets Previous/Next position; it keeps the current scan, task tracking and active report or SVG download. Full-page errors still block new syncs and SVG handoffs even when hidden, and JSON/HTML reports and SVG ZIPs retain their complete-page scope. A healthy page can still be exported when the filtered list is empty.

JSON preflight reports keep `schemaVersion: 1` and the existing `issues` strings. An optional per-item `diagnostics` array adds only `code` and `message`, using `name-rule`, `canvas-size` and `duplicate-name` for current checks. Each entry corresponds to the issue at the same index; unknown codes remain readable. Missing or inconsistent metadata is omitted from reports and appears as Other in the plugin. Existing issues remain the authority for submission checks, and consumers can continue reading reports without diagnostics. HTML reports retain their existing issue text and complete captured scan.

## Complete page report

With default naming, two components on the current page that produce the same icon name (for example, `Arrow Left` and `arrow_left`) both receive a **Duplicate icon name** error. This includes component-set variants and blocks new submissions until you rename and rescan. Use **Problems only**, search, **Locate** and the complete JSON report to review every conflicting component. Skipped drafts do not participate. Custom server naming remains provisional and is not blocked based on local name collisions. The check covers only the current page; server validation is still required across the configured sync scope. Existing tasks continue to be tracked even when the current page has errors.

Expand **Applied rules** to inspect the exact rules used by the current scan: project and revision, dimensions (or Unrestricted), naming pattern, skip prefixes and the server naming warning. An explicit empty prefix list is shown as None. The overview and exported report describe the same scan; GitHub and unpaired defaults are labelled separately.

When connected and idle, **Refresh project rules** reads the latest project context once and rescans the current page. It does not submit or resume a saved task, and keeps the task status and Open task link intact. Old results lose submission, export and navigation eligibility while rules are refreshing. After a failed read, use the same button to retry; Rescan or switching modes cannot revive stale project rules. A missing context (404) keeps the device association and task record so you can retry, while a revoked credential requires reconnecting. GitHub remains usable with its legacy defaults. Rule refresh is unavailable during pairing or task tracking; an overlapping request receives explicit busy feedback. Server validation is still required, including after a clean local scan.

Use **Export JSON report** to download the complete latest successful page scan, including drafts, invalid icons and results hidden by filters. An empty scan can also be exported. The report records the scan time, page, original and locally computed names, node IDs, dimensions, issues, summary and the rules used; connected scans include the project name and revision. It contains no device credentials, GitHub settings or task state. Exporting does not submit or upload anything.

Use **Export HTML report** for a standalone page you can read and print offline. It includes the same complete captured scan as JSON, with every component, draft, issue and applied rule. Use the browser’s Find to locate names or node IDs. The file has no scripts, external resources or embedded SVG, and component text is escaped. Both export formats keep the same scan timestamp and invalidation rules; exporting one temporarily disables both buttons, and a failed download can be retried. The plugin saves the file without opening a browser tab.

This is a local page preflight: server validation is still required, and names are provisional when a custom naming hook runs on the server. Repeated exports keep the same scan timestamp and content. Rescan after editing components; switching pages or modes, changing the project connection or a failed scan disables the old report. Invalidated scans also block submission until a new scan succeeds. Export is available even when errors block submission. A download failure offers an explicit retry without changing filters or workflow status. Rebuild the plugin to use reporting; no server changes or stored-data migration are needed.

## Export a raw SVG handoff

Choose **Export SVG ZIP** to deliver every non-draft component on the current page. The plugin first runs a fresh preflight with the loaded rules; search, Problems only, Issue type and selection do not limit the export. Every icon must pass and every native export must succeed. Errors identify the affected node and keep the download empty; fix the issue and export again. Paired projects use their confirmed rules, while GitHub and unpaired mode use their existing defaults. Refresh unavailable project rules before retrying. Custom server naming hooks require a console sync: download the confirmed snapshot from the console instead.

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
