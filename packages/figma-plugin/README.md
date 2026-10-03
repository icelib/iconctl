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

## Complete page report

Expand **Applied rules** to inspect the exact rules used by the current scan: project and revision, dimensions (or Unrestricted), naming pattern, skip prefixes and the server naming warning. An explicit empty prefix list is shown as None. The overview and exported report describe the same scan; GitHub and unpaired defaults are labelled separately.

When connected and idle, **Refresh project rules** reads the latest project context once and rescans the current page. It does not submit or resume a saved task, and keeps the task status and Open task link intact. Old results lose submission, export and navigation eligibility while rules are refreshing. After a failed read, use the same button to retry; Rescan or switching modes cannot revive stale project rules. A missing context (404) keeps the device association and task record so you can retry, while a revoked credential requires reconnecting. GitHub remains usable with its legacy defaults. Rule refresh is unavailable during pairing or task tracking; an overlapping request receives explicit busy feedback. Server validation is still required, including after a clean local scan.

Use **Export JSON report** to download the complete latest successful page scan, including drafts, invalid icons and results hidden by filters. An empty scan can also be exported. The report records the scan time, page, original and locally computed names, node IDs, dimensions, issues, summary and the rules used; connected scans include the project name and revision. It contains no device credentials, GitHub settings or task state. Exporting does not submit or upload anything.

This is a local page preflight: server validation is still required, and names are provisional when a custom naming hook runs on the server. Repeated exports keep the same scan timestamp and content. Rescan after editing components; switching pages or modes, changing the project connection or a failed scan disables the old report. Invalidated scans also block submission until a new scan succeeds. Export is available even when errors block submission. A download failure offers an explicit retry without changing filters or workflow status. Rebuild the plugin to use reporting; no server changes or stored-data migration are needed.
