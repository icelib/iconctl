# minimal example

```bash
export FIGMA_TOKEN=figu_xxx
pnpm exec iconctl sync --config ./iconctl.config.ts
```

Replace the Figma `file` with your own, or switch the source to `{ type: 'directory', dir: './svg' }`. This directory is a config sample; CI does not call Figma.
