import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2]
assert(['esm', 'cjs'].includes(mode), 'Expected the consumer mode: esm or cjs')
const consumer = await realpath(fileURLToPath(new URL('.', import.meta.url)))
const require = createRequire(import.meta.url)
const entry = mode === 'cjs' ? require.resolve('@iconctl/core') : fileURLToPath(import.meta.resolve('@iconctl/core'))
assert((await realpath(entry)).startsWith(join(consumer, 'node_modules')))
const core = mode === 'cjs' ? require('@iconctl/core') : await import('@iconctl/core')

const fixture = await realpath(await mkdtemp(join(consumer, 'init-')))
const completed = []
const flags = ['--source', 'directory', '--input', './raw-svg', '--prefix', 'brand']
const env = { ...process.env, NO_COLOR: '1', FIGMA_TOKEN: '', FIGMA_CLIENT_ID: '', FIGMA_CLIENT_SECRET: '', FIGMA_REFRESH_TOKEN: '' }
delete env.NODE_OPTIONS
delete env.NODE_PATH
async function scenario(name, action) {
  const cwd = join(fixture, name)
  await mkdir(cwd)
  await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("init must not execute existing configuration")')
  await action(cwd)
  assert(!(await readdir(cwd, { recursive: true })).some(file => file.endsWith('.tmp')))
  completed.push(name)
}
async function cli(cwd, ...args) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [join(consumer, 'node_modules/iconctl/bin/index.js'), 'init', ...args, '--json'], {
      cwd,
      env: { ...env, ICONCTL_FIGMA_CREDENTIALS_FILE: join(cwd, 'credentials.json') },
      timeout: 10000,
    }, (error, stdout, stderr) => {
      if (error?.killed || error?.signal) {
        reject(error)
      }
      else {
        resolve({ code: error?.code ?? 0, stdout, stderr })
      }
    })
    child.stdin.end()
  })
}
try {
  await scenario('packaged-init-and-core-load', async (cwd) => {
    const result = await cli(cwd, ...flags, '--config', 'config/brand.ts', '--json-output', 'generated/icons.json', '--no-interactive')
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), { configFile: join(cwd, 'config/brand.ts'), sourceType: 'directory', prefix: 'brand', outputFiles: [join(cwd, 'config/brand.ts')] })
    const config = await core.loadConfig({ cwd, configFile: 'config/brand.ts' })
    assert.equal(config.sources[0].dir, './raw-svg')
    assert.equal(config.output.json, 'generated/icons.json')
    await mkdir(join(cwd, 'raw-svg'))
    await writeFile(join(cwd, 'raw-svg/arrow.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>')
    const synced = await core.sync({ cwd, config, dryRun: true })
    assert.equal(synced.complete, true)
    assert.deepEqual(synced.diff.added, ['arrow'])
    assert.deepEqual(synced.files, [])
  })
  await scenario('packaged-init-source-templates', async (cwd) => {
    for (const [type, option, input] of [
      ['iconify', '--input', './vendor.json'],
      ['figma', '--input', 'https://www.figma.com/design/abcdefghij/Icons'],
      ['mastergo', '--input', 'https://mastergo.com/file/123?layer_id=4%3A5'],
      ['iconfont', '--input', './iconfont'],
      ['iconfont', '--url', 'https://example.invalid/symbol.js'],
      ['jsdesign', '--input', './jsdesign-svg'],
    ]) {
      const file = `${type}${option}.ts`
      const result = await cli(cwd, '--source', type, option, input, '--prefix', 'brand', '--config', file)
      assert.equal(result.code, 0)
      assert.equal(result.stderr, '')
      assert.equal(JSON.parse(result.stdout).sourceType, type)
      const config = await core.loadConfig({ cwd, configFile: file })
      assert.equal(config.sources[0].type, type)
      assert.equal(config.validate.width, type === 'iconify' ? undefined : 24)
      if (type === 'iconify') {
        await writeFile(join(cwd, 'vendor.json'), JSON.stringify({ prefix: 'vendor', width: 16, height: 32, icons: { arrow: { body: '<path d="M0 0h16v32H0z"/>' } } }))
        const synced = await core.sync({ cwd, config, dryRun: true })
        assert.equal(synced.complete, true)
        assert.equal(synced.json.icons.arrow.width ?? synced.json.width ?? 16, 16)
        assert.equal(synced.json.icons.arrow.height ?? synced.json.height ?? 16, 32)
      }
    }
  })
  await scenario('packaged-init-dry-run', async (cwd) => {
    const before = await readdir(cwd)
    const result = await cli(cwd, ...flags, '--config', 'new/nested/config.ts', '--dry-run')
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), { configFile: join(cwd, 'new/nested/config.ts'), sourceType: 'directory', prefix: 'brand', outputFiles: [], dryRun: true })
    assert.deepEqual(await readdir(cwd), before)
  })
  await scenario('packaged-init-future-case-alias', async (cwd) => {
    const before = await readdir(cwd)
    const result = await cli(cwd, ...flags, '--config', 'abc.ts', '--json-output', 'ABC.TS', '--dry-run')
    assert.equal(result.stderr, '')
    if (process.platform === 'darwin' || process.platform === 'win32') {
      assert.equal(result.code, 1)
      assert.equal(JSON.parse(result.stdout).error.phase, 'arguments')
      assert.match(JSON.parse(result.stdout).error.message, /conflicts/)
    }
    else {
      assert.equal(result.code, 0)
      assert.deepEqual(JSON.parse(result.stdout).outputFiles, [])
    }
    assert.deepEqual(await readdir(cwd), before)
  })
  await scenario('packaged-init-no-overwrite', async (cwd) => {
    const original = join(cwd, 'original.ts')
    await writeFile(original, 'original bytes')
    await link(original, join(cwd, 'hardlink.ts'))
    await symlink(original, join(cwd, 'symlink.ts'))
    await symlink(join(cwd, 'missing'), join(cwd, 'dangling.ts'))
    await mkdir(join(cwd, 'directory.ts'))
    for (const target of ['original.ts', 'hardlink.ts', 'symlink.ts', 'dangling.ts', 'directory.ts']) {
      const result = await cli(cwd, ...flags, '--config', target)
      assert.equal(result.code, 1)
      assert.equal(result.stderr, '')
      assert.equal(JSON.parse(result.stdout).error.phase, 'execution')
      assert.match(JSON.parse(result.stdout).error.message, /Config already exists/)
    }
    assert.equal(await readFile(original, 'utf8'), 'original bytes')
  })
  await scenario('packaged-init-arguments', async (cwd) => {
    for (const args of [[], ['--source'], [...flags, '--continue'], [...flags, '--force'], [...flags, '--input', 'other'], [...flags, '--config', 'config.json'], [...flags, '--json-output', 'iconctl.config.ts']]) {
      const result = await cli(cwd, ...args)
      assert.equal(result.code, 1)
      assert.equal(result.stderr, '')
      assert.deepEqual({ command: JSON.parse(result.stdout).command, success: JSON.parse(result.stdout).success, phase: JSON.parse(result.stdout).error.phase }, { command: 'init', success: false, phase: 'arguments' })
    }
    assert.deepEqual(await readdir(cwd), ['iconctl.config.mjs'])
  })
  await scenario('packaged-init-concurrent', async (cwd) => {
    const results = await Promise.all([cli(cwd, ...flags), cli(cwd, ...flags)])
    assert.deepEqual(results.map(result => result.code).sort(), [0, 1])
    assert.equal((await core.loadConfig({ cwd, configFile: 'iconctl.config.ts' })).prefix, 'brand')
  })
  console.log(JSON.stringify({ mode, runtime: process.version, scenarios: completed, passed: true }))
}
finally {
  await rm(fixture, { recursive: true, force: true })
}
