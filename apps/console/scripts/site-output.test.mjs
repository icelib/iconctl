import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
// This subprocess suite intentionally stays outside both Vitest runtimes.
// eslint-disable-next-line test/no-import-node-test
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const scripts = fileURLToPath(new URL('./', import.meta.url))
const { scripts: commands } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

async function put(root, files) {
  for (const [name, contents] of Object.entries(files)) {
    const location = path.join(root, name)
    await mkdir(path.dirname(location), { recursive: true })
    await writeFile(location, contents)
  }
}
async function files(root) {
  const result = {}
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name)
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), relative)
      }
      else {
        result[relative] = entry.isSymbolicLink() ? '<symlink>' : await readFile(path.join(directory, entry.name), 'utf8')
      }
    }
  }
  await walk(root)
  return result
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iconctl-site-output-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = path.join(root, 'apps/console')
  const source = path.join(root, 'apps/website/.vitepress/dist')
  const target = path.join(app, 'dist/public')
  const unrelated = path.join(root, 'caller')
  await mkdir(path.join(app, 'scripts'), { recursive: true })
  await mkdir(unrelated)
  for (const name of ['site-output.mjs', 'prepare-output.mjs', 'assemble.mjs']) {
    await cp(path.join(scripts, name), path.join(app, 'scripts', name))
  }
  await put(source, { 'index.html': 'docs-v1', 'old-page.html': 'old-page', 'assets/old.svg': 'old-resource' })
  await put(target, { 'index.html': 'last-good-docs', 'app/index.html': 'last-good-app' })
  await put(app, { 'dist/keep.txt': 'other-output', 'src/user.txt': 'source', 'public/user.txt': 'public-input' })
  await put(unrelated, { 'dist/public/user.txt': 'unrelated-output' })
  function run(name, expected = 0) {
    const result = spawnSync(process.execPath, [path.join(app, 'scripts', name)], { cwd: unrelated, encoding: 'utf8' })
    assert.equal(result.error, undefined)
    if (expected === 0) {
      assert.equal(result.status, 0, result.stderr)
    }
    else {
      assert.notEqual(result.status, 0)
    }
    return result
  }
  return { root, app, source, target, unrelated, run }
}

test('rebuild removes deleted/renamed pages and resources, updates names, keeps the fresh app and copies every new document', async (t) => {
  const f = await fixture(t)
  f.run('prepare-output.mjs')
  await put(f.target, { 'app/index.html': 'app-v1' })
  f.run('assemble.mjs')
  assert.equal((await files(f.target))['old-page.html'], 'old-page')
  await rm(f.source, { recursive: true })
  const currentDocs = {
    'index.html': 'docs-v2',
    'renamed-page.html': 'new-page',
    'assets/new.svg': 'new-resource',
    'zh/guide.html': '中文',
    'nested/deeper/doc.html': 'nested',
    'assets/hash#percent%.svg': 'literal-file-name',
    '404.html': 'missing',
  }
  await put(f.source, currentDocs)
  f.run('prepare-output.mjs')
  assert.deepEqual(await files(f.target), {})
  await put(f.target, { 'app/index.html': 'app-v2', 'app/assets/main.js': 'new-app-code' })
  f.run('assemble.mjs')
  assert.deepEqual(await files(f.target), { ...currentDocs, 'app/index.html': 'app-v2', 'app/assets/main.js': 'new-app-code' })
  assert.deepEqual(await files(f.source), currentDocs)
  assert.equal(await readFile(path.join(f.app, 'dist/keep.txt'), 'utf8'), 'other-output')
  assert.equal(await readFile(path.join(f.app, 'src/user.txt'), 'utf8'), 'source')
  assert.equal(await readFile(path.join(f.app, 'public/user.txt'), 'utf8'), 'public-input')
  assert.deepEqual(await files(f.unrelated), { 'dist/public/user.txt': 'unrelated-output' })
})

for (const reserved of ['app', 'app.html', 'api', 'api.html', 'login', 'login.html', 'APP']) {
  test(`preflights all entries before cleanup or copy for reserved ${reserved}`, async (t) => {
    const f = await fixture(t)
    // An earlier ordinary entry must not be copied before the conflict is found.
    await put(f.source, { '000-first.html': 'must-not-be-copied', [reserved]: 'reserved' })
    const original = await files(f.target)
    const input = await files(f.source)
    for (const script of ['prepare-output.mjs', 'assemble.mjs']) {
      assert.match(f.run(script, 1).stderr, /reserved route/)
      assert.deepEqual(await files(f.target), original)
      assert.deepEqual(await files(f.source), input)
    }
  })
}

for (const missing of ['directory', 'index']) {
  test(`missing website ${missing} preserves existing assembled output`, async (t) => {
    const f = await fixture(t)
    await rm(missing === 'directory' ? f.source : path.join(f.source, 'index.html'), { recursive: true })
    const original = await files(f.target)
    for (const script of ['prepare-output.mjs', 'assemble.mjs']) {
      assert.match(f.run(script, 1).stderr, /ENOENT/)
      assert.deepEqual(await files(f.target), original)
    }
  })
}

for (const linked of ['dist', 'public']) {
  test(`rejects linked output ${linked} without changing an external directory`, async (t) => {
    const f = await fixture(t)
    const external = path.join(f.root, 'external')
    await put(external, { 'user.txt': 'external', 'public/user.txt': 'external-public' })
    const location = linked === 'dist' ? path.join(f.app, 'dist') : f.target
    await rm(location, { recursive: true })
    await symlink(external, location, 'dir')
    const original = await files(external)
    for (const script of ['prepare-output.mjs', 'assemble.mjs']) {
      assert.match(f.run(script, 1).stderr, /real directory/)
      assert.deepEqual(await files(external), original)
      assert.equal((await lstat(location)).isSymbolicLink(), true)
    }
  })
}

test('cleans an output leaf symlink without following it or deleting its external target', async (t) => {
  const f = await fixture(t)
  const external = path.join(f.root, 'external')
  await put(external, { 'user.txt': 'external' })
  await symlink(external, path.join(f.target, 'stale-link'), 'dir')
  f.run('prepare-output.mjs')
  assert.deepEqual(await files(f.target), {})
  assert.deepEqual(await files(external), { 'user.txt': 'external' })
})

test('direct assembly rejects a linked destination subtree before copying any document', async (t) => {
  const f = await fixture(t)
  const external = path.join(f.root, 'external')
  await put(external, { 'old.svg': 'external-resource' })
  await symlink(external, path.join(f.target, 'assets'), 'dir')
  const original = await files(f.target)
  assert.match(f.run('assemble.mjs', 1).stderr, /Assembled output contains an unsupported entry/)
  assert.deepEqual(await files(f.target), original)
  assert.deepEqual(await files(external), { 'old.svg': 'external-resource' })
})

for (const linked of ['website', '.vitepress', 'dist', 'entry']) {
  test(`rejects a linked website ${linked} before any output mutation`, async (t) => {
    const f = await fixture(t)
    const external = path.join(f.root, 'external')
    await put(external, { 'index.html': 'external', '.vitepress/dist/index.html': 'external' })
    const location = linked === 'entry'
      ? path.join(f.source, 'linked')
      : linked === 'dist'
        ? f.source
        : linked === '.vitepress' ? path.dirname(f.source) : path.dirname(path.dirname(f.source))
    await rm(location, { recursive: true, force: true })
    await symlink(external, location, 'dir')
    const original = await files(f.target)
    const input = await files(external)
    for (const script of ['prepare-output.mjs', 'assemble.mjs']) {
      assert.match(f.run(script, 1).stderr, /real directory|unsupported entry/)
      assert.deepEqual(await files(f.target), original)
      assert.deepEqual(await files(external), input)
    }
  })
}

test('prepares a first build without requiring dist to exist', async (t) => {
  const f = await fixture(t)
  await rm(path.join(f.app, 'dist'), { recursive: true })
  f.run('prepare-output.mjs')
  await put(f.target, { 'app/index.html': 'fresh-app' })
  f.run('assemble.mjs')
  assert.deepEqual(await files(f.target), { ...await files(f.source), 'app/index.html': 'fresh-app' })
})

test('the actual build command keeps old output on typecheck failure and prepares before Vite on success', async (t) => {
  const f = await fixture(t)
  const bin = path.join(f.root, 'bin')
  await mkdir(bin)
  // Stub only external build tools; execute the real package command and scripts.
  for (const name of ['pnpm', 'vue-tsc', 'vite']) {
    const executable = path.join(bin, name)
    await writeFile(executable, `#!${process.execPath}\n${name === 'vue-tsc'
      ? 'process.exit(Number(process.env.TYPECHECK_EXIT ?? 0))'
      : name === 'vite'
        ? `const fs = require('node:fs'); if (fs.existsSync('dist/public/index.html')) process.exit(9); fs.mkdirSync('dist/public/app', {recursive:true}); fs.writeFileSync('dist/public/app/index.html', 'new-app');`
        : ''}\n`)
    await chmod(executable, 0o755)
  }
  // Use the currently running Node for the package command's native scripts too.
  await symlink(process.execPath, path.join(bin, 'node'))
  const original = await files(f.target)
  function build(failure) {
    return spawnSync('/bin/sh', ['-c', commands.build], {
      cwd: f.app,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TYPECHECK_EXIT: failure ? '2' : '0' },
    })
  }
  assert.equal(build(true).status, 2)
  assert.deepEqual(await files(f.target), original)
  const success = build(false)
  assert.equal(success.status, 0, success.stderr)
  assert.deepEqual(await files(f.target), { ...await files(f.source), 'app/index.html': 'new-app' })
})
