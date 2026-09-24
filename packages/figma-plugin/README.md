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
