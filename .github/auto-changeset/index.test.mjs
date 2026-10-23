import assert from 'node:assert/strict'
// These workflow scripts run directly in Node, outside the Vitest workspaces.
// eslint-disable-next-line test/no-import-node-test
import { test } from 'node:test'
import { processPullRequest } from './index.mjs'
import { checkReleaseIntent } from './packages.mjs'

function clientFixture({ files = ['apps/cli/src/index.ts'], privatePackage = false, changedHead = false, fork = false } = {}) {
  const contents = {
    'pnpm-workspace.yaml': 'packages: [apps/*, packages/*]',
    'apps/cli/package.json': JSON.stringify({ name: 'iconctl', private: privatePackage }),
    'packages/core/package.json': '{"name":"@iconctl/core"}',
  }
  const writes = []
  const client = {
    getPullRequest: async () => ({
      number: 7,
      title: 'fix: preserve icon names',
      labels: [],
      head: { ref: 'fix/icons', sha: 'head', repo: { full_name: fork ? 'contributor/iconctl' : 'icelib/iconctl' } },
      base: { repo: { full_name: 'icelib/iconctl' } },
    }),
    getPullRequestFiles: async () => files,
    getContent: async (filename, ref) => {
      assert.equal(ref, 'head')
      return contents[filename]
    },
    getRef: async () => ({ object: { sha: changedHead ? 'new-head' : 'head' } }),
    getCommit: async sha => ({ tree: { sha: `${sha}-tree` } }),
    createBlob: async (content) => {
      writes.push(content)
      return { sha: 'blob' }
    },
    createTree: async () => ({ sha: 'tree' }),
    createCommit: async (_message, _tree, parents) => {
      assert.deepEqual(parents, ['head'])
      return { sha: 'commit' }
    },
    updateRef: async () => {},
    listComments: async () => [],
    createComment: async (_number, content) => writes.push(content),
  }
  return { client, contents, writes, files }
}

test('automatic CLI intent satisfies the shared checker', async () => {
  const { client, contents, writes, files } = clientFixture()
  assert.deepEqual(await processPullRequest(client, 7, { expectedHeadSha: 'head' }), { action: 'committed', number: 7, path: '.changeset/auto-pr-7.md', sha: 'commit' })
  contents['.changeset/auto-pr-7.md'] = writes[0]
  assert.deepEqual(await checkReleaseIntent([...files, '.changeset/auto-pr-7.md'], async path => contents[path]), { packages: ['iconctl'], missing: [] })
})

test('automatic mixed core and CLI intent covers the same package set', async () => {
  const { client, contents, writes, files } = clientFixture({ files: ['packages/core/src/index.ts', 'apps/cli/src/index.ts'] })
  await processPullRequest(client, 7)
  contents['.changeset/auto-pr-7.md'] = writes[0]
  assert.deepEqual(await checkReleaseIntent([...files, '.changeset/auto-pr-7.md'], async path => contents[path]), { packages: ['@iconctl/core', 'iconctl'], missing: [] })
})

test('automatic intents skip private package changes', async () => {
  const { client, writes } = clientFixture({ privatePackage: true })
  assert.deepEqual(await processPullRequest(client, 7), { action: 'skipped', number: 7 })
  assert.deepEqual(writes, [])
})

test('stale event and concurrent head changes cannot write an intent', async () => {
  const { client, writes } = clientFixture({ changedHead: true })
  await assert.rejects(processPullRequest(client, 7, { expectedHeadSha: 'old-head' }), /head changed before/)
  await assert.rejects(processPullRequest(client, 7, { expectedHeadSha: 'head' }), /head changed while/)
  assert.deepEqual(writes, [])
})

test('fork changes request a manual intent without committing to the fork', async () => {
  const { client, writes } = clientFixture({ fork: true })
  assert.deepEqual(await processPullRequest(client, 7), { action: 'commented', number: 7 })
  assert.equal(writes.length, 1)
  assert.match(writes[0], /Please add a \.changeset/)
})
