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

Do not call the live Figma API in CI. Use SVG fixtures under `packages/core/test/fixtures`. New platforms should land as another `sources[].type` adapter.

Publishable package changes need `pnpm change` and Conventional Commits.
