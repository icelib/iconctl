import type { MonorepoConfig } from 'repoctl'

export default {
  commands: {
    create: {
      defaultTemplate: 'tsdown',
      renameJson: false,
    },
    clean: {
      autoConfirm: false,
      includePrivate: true,
    },
    upgrade: {
      skipOverwrite: false,
      mergeTargets: true,
    },
    doctor: {
      // Preserve upstream baselines for three-way merges of reviewed overrides.
      suppressions: Object.entries({
        'package.json': 'iconctl package identity, runtime policy and project scripts',
        'pnpm-workspace.yaml': 'iconctl workspace globs, dependency overrides and traversal patch',
        'repoctl.config.ts': 'iconctl nightly, documentation channels and tooling policy',
        'eslint.config.js': 'Resolve repository tooling from the root when Turbo runs ESLint in a package',
        '.gitignore': 'iconctl generated artifacts and local cache exclusions',
        'AGENTS.md': 'Supported iconctl development runtime',
        'CONTRIBUTING.md': 'iconctl contribution and release instructions',
        'SECURITY.md': 'Report iconctl vulnerabilities to the iconctl repository',
        '.github/ISSUE_TEMPLATE/config.yml': 'Route discussions to the iconctl repository',
        '.github/workflows/ci.yml': 'iconctl Node 22/24 matrix and repository verification',
        '.github/workflows/release.yml': 'Document the configured iconctl nightly time',
        '.github/workflows/release-intent-auto.yml': 'Load the shared manifest detector from trusted workflow source',
        '.github/workflows/release-intent-check.yml': 'Validate intent for every affected public workspace',
        '.github/auto-changeset/index.mjs': 'Shared manifest detector for apps and packages',
      }).map(([path, reason]) => ({ id: 'root-asset-drift', path, reason })),
    },
    release: {
      qualityScripts: ['build', 'lint', 'typecheck', 'tsd', 'test', 'test:package'],
      nightly: {
        provider: 'npm',
        schedule: '0 18 * * *',
      },
      hooks: {
        afterPublish: [{ script: 'release:sync-npmmirror', continueOnError: true, idempotent: true }],
      },
    },
    docs: {
      sites: {
        website: {
          packages: ['@iconctl/core', 'iconctl', '@iconctl/icons'],
          releaseInputs: {
            '@iconctl/core': [
              'packages/core/src/**',
              'packages/core/package.json',
              'packages/core/tsconfig.json',
              'packages/core/tsdown.config.ts',
              'packages/core/THIRD_PARTY_NOTICES',
              'tsconfig.json',
              'patches/readdirp@5.1.1.patch',
              'LICENSE',
            ],
            'iconctl': [
              'apps/cli/src/**',
              'apps/cli/bin/**',
              'apps/cli/package.json',
              'apps/cli/tsconfig.json',
              'apps/cli/tsdown.config.ts',
              'tsconfig.json',
              'LICENSE',
            ],
            '@iconctl/icons': [
              'packages/icons/package.json',
              'packages/icons/icons.json',
              'packages/icons/CHANGELOG.md',
              'packages/icons/README.md',
              'packages/icons/preview.html',
              'packages/icons/src/**',
              'packages/icons/svg/**',
              'LICENSE',
            ],
          },
          buildScript: 'docs:build',
          preview: { deployScript: 'docs:deploy:preview' },
          stable: {
            deployScript: 'docs:deploy:stable',
            url: 'https://iconctl.icebreaker.top',
          },
          patchPaths: [],
        },
      },
    },
  },
  tooling: {
    commitlint: {
      extends: ['@commitlint/config-conventional'],
    },
    eslint: {
      astro: true,
      configs: [{ ignores: [
        '**/fixtures/**',
        '**/*.md',
        'packages/icons/icons.json',
        'packages/icons/preview.html',
        'packages/icons/svg/**',
        'examples/app-json/src/icons.json',
        'examples/app-json/preview.html',
      ] }],
      svelte: true,
      vue: true,
    },
    stylelint: {
      rules: {
        'media-feature-range-notation': 'prefix',
      },
    },
    vitest: {
      includeWorkspaceRootConfig: false,
      coverageExclude: ['**/dist/**'],
      coverageSkipFull: true,
    },
    vitestProject: {
      globals: true,
      testTimeout: 60_000,
    },
  },
} satisfies MonorepoConfig
