import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
// These workflow scripts run directly in Node, outside the Vitest workspaces.
// eslint-disable-next-line test/no-import-node-test
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('Git check validates committed head data, including deletions, without reading dirty manifests', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'iconctl-release-intent-'))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const commit = () => {
    git('add', '.')
    git('-c', 'user.name=Release Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'test')
    return git('rev-parse', 'HEAD')
  }
  const run = (base, head) => spawnSync(process.execPath, [fileURLToPath(new URL('./check.mjs', import.meta.url))], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, RELEASE_BASE_SHA: base, RELEASE_HEAD_SHA: head, RELEASE_HEAD_REF: 'feature/icons' },
  })
  try {
    git('init', '--quiet')
    await mkdir(path.join(cwd, 'apps/cli'), { recursive: true })
    await mkdir(path.join(cwd, '.changeset'))
    await writeFile(path.join(cwd, 'pnpm-workspace.yaml'), 'packages: [apps/*]')
    await writeFile(path.join(cwd, 'apps/cli/package.json'), '{"name":"iconctl"}')
    await writeFile(path.join(cwd, 'apps/cli/old.ts'), 'export const old = true')
    await writeFile(path.join(cwd, '.changeset/old.md'), '---\niconctl: patch\n---\n\nOld intent.\n')
    const base = commit()
    await rm(path.join(cwd, 'apps/cli/old.ts'))
    await rm(path.join(cwd, '.changeset/old.md'))
    const missing = run(base, commit())
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /Missing release intents for: iconctl/)
    await writeFile(path.join(cwd, '.changeset/new.md'), '---\niconctl: patch\n---\n\nRemove old source.\n')
    const head = commit()
    await writeFile(path.join(cwd, 'apps/cli/package.json'), '{"name":"wrong-dirty-package"}')
    const covered = run(base, head)
    assert.equal(covered.status, 0, covered.stderr)
    assert.match(covered.stdout, /Release intents cover: iconctl/)
  }
  finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
