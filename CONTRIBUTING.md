# Contributing to iconctl

Use Node.js 24.22.1 (`nvm use`) and pnpm 12.6.0. CI also verifies Node.js 22.23.4.
Run `corepack enable`, then `pnpm install --frozen-lockfile`. Lefthook installs
the commit hooks; `pnpm exec lefthook install` reinstalls them when needed.

Before opening a pull request, run:

```sh
pnpm exec repo config validate --json
pnpm run repo:doctor --strict
pnpm exec repo check --full
pnpm tsd
pnpm test:package
```

Console changes also require `pnpm --filter @iconctl/console test:build`,
`pnpm --filter @iconctl/console test:worker`, and the Chromium E2E suite.
Website changes require `pnpm --filter @iconctl/website test:channels`.

Public packages are `@iconctl/core`, `iconctl` (in `apps/cli`), and
`@iconctl/icons`. Create release intent with `pnpm change` for affected public
packages. Private applications and documentation do not need a package bump.
Use Conventional Commits.

Same-repository pull requests receive an automated patch intent for uncovered
public packages. The `release:minor` and `release:major` labels override that
default. Existing intents are preserved. Fork authors add their own intent.
The `Automatic Release Intent` workflow can backfill merged PR numbers.

The workspace uses repoctl 6.0.1. Review `pnpm exec repo upgrade --markdown`
before upgrading and commit `.repoctl/baselines/root` with managed assets.
Keep project policy in `repoctl.config.ts` and package-level configuration.
Doctor suppressions identify reviewed project customizations by exact path;
they do not suppress template-version, schema, dependency or release failures.

See [release and website operations](docs/releasing.md) for nightly installs,
GitHub setup and production deployment. Report bugs at
https://github.com/icelib/iconctl/issues.
