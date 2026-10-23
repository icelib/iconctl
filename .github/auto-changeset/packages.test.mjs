import assert from 'node:assert/strict'
// These workflow scripts run directly in Node, outside the Vitest workspaces.
// eslint-disable-next-line test/no-import-node-test
import { test } from 'node:test'
import { changedChangesets, checkReleaseIntent, publishablePackagesForFiles } from './packages.mjs'

function fixture(overrides = {}) {
  const files = {
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n  - examples/*\n  - "!**/test/**"\n',
    'apps/cli/package.json': JSON.stringify({ name: 'iconctl' }),
    'packages/core/package.json': JSON.stringify({ name: '@iconctl/core' }),
    'apps/console/package.json': JSON.stringify({ name: '@iconctl/console', private: true }),
    'packages/console-contracts/package.json': JSON.stringify({ name: '@iconctl/console-contracts', private: true }),
    ...overrides,
  }
  return async filename => files[filename]
}

test('CLI-only changes identify the public app', async () => {
  assert.deepEqual(await publishablePackagesForFiles(['apps/cli/src/index.ts'], fixture()), ['iconctl'])
})

test('private apps and packages require no intent', async () => {
  assert.deepEqual(await publishablePackagesForFiles(['apps/console/src/main.ts', 'packages/console-contracts/src/index.ts'], fixture()), [])
})

test('core and CLI changes include both packages once', async () => {
  assert.deepEqual(await publishablePackagesForFiles(['packages/core/src/index.ts', 'apps/cli/src/index.ts', 'apps/cli/package.json'], fixture()), ['@iconctl/core', 'iconctl'])
})

test('workspace patterns include public examples and respect exclusions', async () => {
  const readContent = fixture({
    'pnpm-workspace.yaml': 'packages: ["{apps,packages,examples}/*", "!examples/excluded"]',
    'examples/sdk/package.json': '{"name":"example-sdk"}',
    'examples/excluded/package.json': '{"name":"excluded"}',
    'outside/app/package.json': '{"name":"outside"}',
  })
  assert.deepEqual(await publishablePackagesForFiles(['examples/sdk/index.ts', 'examples/excluded/index.ts', 'outside/app/index.ts'], readContent), ['example-sdk'])
})

test('dist output and root files do not trigger a package release', async () => {
  assert.deepEqual(await publishablePackagesForFiles(['apps/cli/dist/index.js', 'packages/core/dist/index.mjs', 'README.md'], fixture()), [])
})

test('deleting a source file still affects its existing package', async () => {
  assert.deepEqual(await publishablePackagesForFiles([{ filename: 'apps/cli/src/old.ts', status: 'removed' }], fixture()), ['iconctl'])
})

test('removing a package or making it private requires no impossible intent', async () => {
  const readContent = fixture({ 'apps/cli/package.json': undefined, 'packages/core/package.json': '{"name":"@iconctl/core","private":true}' })
  assert.deepEqual(await publishablePackagesForFiles(['apps/cli/package.json', 'packages/core/package.json'], readContent), [])
})

test('moving a package finds the current manifest and preserves its name', async () => {
  const readContent = fixture({ 'apps/cli/package.json': undefined, 'packages/cli/package.json': '{"name":"iconctl"}' })
  assert.deepEqual(await publishablePackagesForFiles([{ filename: 'packages/cli/src/index.ts', previous_filename: 'apps/cli/src/index.ts', status: 'renamed' }], readContent), ['iconctl'])
})

test('moving a file between retained packages affects both packages', async () => {
  assert.deepEqual(await publishablePackagesForFiles([{ filename: 'apps/cli/src/shared.ts', previous_filename: 'packages/core/src/shared.ts', status: 'renamed' }], fixture()), ['@iconctl/core', 'iconctl'])
})

test('invalid manifests fail instead of silently omitting releases', async () => {
  await assert.rejects(publishablePackagesForFiles(['apps/cli/src/index.ts'], fixture({ 'apps/cli/package.json': 'invalid json' })), SyntaxError)
})

test('release intent must cover every affected public package', async () => {
  const readContent = fixture({ '.changeset/change.md': '---\n"@iconctl/core": patch\n---\n\nChange.\n' })
  assert.deepEqual(await checkReleaseIntent(['apps/cli/src/index.ts', 'packages/core/src/index.ts', '.changeset/change.md'], readContent), {
    packages: ['@iconctl/core', 'iconctl'],
    missing: ['iconctl'],
  })
})

test('a valid intent covers CLI-only changes', async () => {
  const readContent = fixture({ '.changeset/change.md': '---\niconctl: minor\n---\n\nChange.\n' })
  assert.deepEqual(await checkReleaseIntent(['apps/cli/src/index.ts', '.changeset/change.md'], readContent), { packages: ['iconctl'], missing: [] })
})

test('deleted release intents cannot satisfy the check', async () => {
  assert.deepEqual(changedChangesets([{ filename: '.changeset/removed.md', status: 'removed' }]), [])
  assert.deepEqual(await checkReleaseIntent(['apps/cli/src/index.ts', { filename: '.changeset/removed.md', status: 'removed' }], fixture()), { packages: ['iconctl'], missing: ['iconctl'] })
})
