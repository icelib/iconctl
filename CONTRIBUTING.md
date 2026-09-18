# Contributing to iconctl

English | [简体中文](README.zh-CN.md)

## Setup

1. Node.js 22.13+ and pnpm
2. `pnpm install`
3. `pnpm exec repo doctor`
4. `pnpm exec repo check --full`

## Layout

- `packages/core` — `@iconctl/core` pipeline
- `apps/cli` — `iconctl` CLI
- `apps/website` — VitePress docs
- `examples/minimal` — sample config
- `packages/icons` — dogfood Iconify package (`preview.html`, `CHANGELOG.md`); `pnpm --filter @iconctl/icons sync`

Do not call the live Figma API in CI. Use SVG fixtures under `packages/core/test/fixtures`. The website gallery snapshot is `pnpm --filter @iconctl/website sync:demo:svg` (Lucide SVGs through the same pipeline). `sync:demo` talks to Figma and is manual: duplicate the Lucide community file, set `FIGMA_TOKEN` and `ICONCTL_FIGMA_FILE`. New platforms should land as another `sources[].type` adapter.

Publishable package changes need `pnpm change` and Conventional Commits.
