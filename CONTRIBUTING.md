# Contributing to figma-iconify

English | [简体中文](README.zh-CN.md)

## Setup

1. Node.js 22.13+ and pnpm
2. `pnpm install`
3. `pnpm exec repo doctor`
4. `pnpm exec repo check --full`

## Layout

- `packages/core` — `@icebreakers/figma-iconify` pipeline
- `apps/cli` — `figma-iconify` CLI
- `apps/website` — VitePress docs
- `examples/minimal` — sample config

Do not call the live Figma API in CI. Use SVG fixtures under `packages/core/test/fixtures`.

Publishable package changes need `pnpm change` and Conventional Commits.
