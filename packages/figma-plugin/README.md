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
