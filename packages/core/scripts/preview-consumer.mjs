import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const mode = process.argv[2]
assert(['esm', 'cjs'].includes(mode), 'Expected the consumer mode: esm or cjs')
const consumer = await realpath(fileURLToPath(new URL('.', import.meta.url)))
const require = createRequire(import.meta.url)
const packages = {}
for (const name of ['@iconctl/core', 'iconctl']) {
  const entry = mode === 'cjs' ? require.resolve(name) : fileURLToPath(import.meta.resolve(name))
  assert((await realpath(entry)).startsWith(join(consumer, 'node_modules')))
  packages[name] = mode === 'cjs' ? require(name) : await import(name)
}
const core = packages['@iconctl/core']
const facade = packages.iconctl
const icons = { prefix: 'brand', width: 24, height: 16, icons: { arrow: { body: '<path d="M0 0h8v8H0z"/>', hidden: true } }, aliases: { rotated: { parent: 'arrow', rotate: 1 } } }
const source = `\uFEFF${JSON.stringify(icons)}`
const exec = promisify(execFile)
const fixture = await realpath(await mkdtemp(join(consumer, 'preview-')))
const completed = []
async function scenario(name, action) {
  const cwd = join(fixture, name)
  await mkdir(cwd)
  const input = join(cwd, 'icons.json')
  await writeFile(input, source)
  await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("local preview must not execute configuration")')
  await action(cwd, input)
  assert.equal(await readFile(input, 'utf8'), source)
  assert(!(await readdir(cwd)).some(file => file.startsWith('.iconctl-')))
  completed.push(name)
}
const env = { ...process.env, NO_COLOR: '1', FIGMA_TOKEN: '', FIGMA_CLIENT_ID: '', FIGMA_CLIENT_SECRET: '', FIGMA_REFRESH_TOKEN: '' }
delete env.NODE_OPTIONS
delete env.NODE_PATH
async function cli(cwd, ...args) {
  try {
    const result = await exec(process.execPath, [join(consumer, 'node_modules/iconctl/bin/index.js'), 'preview', ...args, '--json'], {
      cwd,
      env: { ...env, ICONCTL_FIGMA_CREDENTIALS_FILE: join(cwd, 'credentials.json') },
      timeout: 10000,
    })
    return { code: 0, ...result }
  }
  catch (error) {
    if (error.killed || error.signal) {
      throw error
    }
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}
try {
  await scenario('public-preview-api-and-facade', async (cwd, input) => {
    assert.equal(core.renderPreviewHtml, facade.renderPreviewHtml)
    assert.equal(core.writePreviewHtml, facade.writePreviewHtml)
    const expected = core.renderPreviewHtml(icons)
    const output = join(cwd, 'reports', 'preview.html')
    await core.writePreviewHtml(output, icons)
    assert.equal(await readFile(output, 'utf8'), expected)
    await writeFile(output, 'previous report')
    await facade.writePreviewHtml(output, icons, { inputs: [input] })
    assert.equal(await readFile(output, 'utf8'), expected)
    assert.equal((expected.match(/<figure class="icon"/g) ?? []).length, 2)
    assert.deepEqual(await readdir(join(cwd, 'reports')), ['preview.html'])
  })
  await scenario('public-preview-dry-run', async (cwd, input) => {
    const before = await readdir(cwd)
    await facade.writePreviewHtml(join(cwd, 'new', 'preview.html'), icons, { inputs: [input], dryRun: true })
    await assert.rejects(core.writePreviewHtml(join(cwd, 'new', 'invalid.html'), { ...icons, aliases: { broken: { parent: 'missing' } } }, { dryRun: true }), core.IconctlError)
    assert.deepEqual(await readdir(cwd), before)
  })
  await scenario('public-preview-source-protection', async (cwd, input) => {
    const hardlink = join(cwd, 'hardlink.html')
    const alias = join(cwd, 'alias')
    const linkedInput = join(cwd, 'linked-input.json')
    await link(input, hardlink)
    await symlink(cwd, alias)
    await symlink(input, linkedInput)
    for (const dryRun of [false, true]) {
      for (const output of [input, hardlink, join(alias, 'icons.json')]) {
        await assert.rejects(facade.writePreviewHtml(output, icons, { inputs: [linkedInput], dryRun }), /conflicts with input/)
      }
      await assert.rejects(facade.writePreviewHtml(linkedInput, icons, { dryRun }), /regular file/)
    }
  })
  await scenario('packaged-preview-local-input', async (cwd, input) => {
    const result = await cli(cwd, '--input', input, '--output', 'reports/local.html')
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), { input: { file: input, prefix: 'brand' }, count: 2, outputFiles: [join(cwd, 'reports/local.html')] })
    assert.equal(await readFile(join(cwd, 'reports/local.html'), 'utf8'), core.renderPreviewHtml(icons))
    assert.deepEqual(await readdir(cwd), ['iconctl.config.mjs', 'icons.json', 'reports'])
    await rm(join(cwd, 'iconctl.config.mjs'))
    const defaultResult = await cli(cwd, '--input', 'icons.json')
    assert.equal(defaultResult.code, 0)
    assert.equal(defaultResult.stderr, '')
    assert.deepEqual(JSON.parse(defaultResult.stdout).outputFiles, [join(cwd, 'preview.html')])
  })
  await scenario('packaged-preview-dry-run', async (cwd, input) => {
    const before = await readdir(cwd)
    const result = await cli(cwd, '--input', 'icons.json', '--output', 'new/preview.html', '--dry-run')
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), { input: { file: input, prefix: 'brand' }, count: 2, outputFiles: [], dryRun: true })
    assert.deepEqual(await readdir(cwd), before)
  })
  await scenario('packaged-preview-failure-boundary', async (cwd) => {
    await writeFile(join(cwd, 'preview.html'), 'previous report')
    await writeFile(join(cwd, 'invalid.json'), '{')
    for (const [args, phase] of [
      [['--input'], 'arguments'],
      [['--input', 'icons.json', '--continue'], 'arguments'],
      [['--input', 'icons.json', '--input', 'again.json'], 'arguments'],
      [['--input', 'invalid.json'], 'execution'],
      [['--input', 'icons.json', '--output', 'icons.json', '--dry-run'], 'execution'],
    ]) {
      const result = await cli(cwd, ...args)
      assert.equal(result.code, 1)
      assert.equal(result.stderr, '')
      const report = JSON.parse(result.stdout)
      assert.equal(report.success, false)
      assert.equal(report.command, 'preview')
      assert.equal(report.error.phase, phase)
      assert.equal('valid' in report, false)
      assert.equal(await readFile(join(cwd, 'preview.html'), 'utf8'), 'previous report')
    }
  })
  console.log(JSON.stringify({ mode, runtime: process.version, scenarios: completed, passed: true }))
}
finally {
  await rm(fixture, { recursive: true, force: true })
}
