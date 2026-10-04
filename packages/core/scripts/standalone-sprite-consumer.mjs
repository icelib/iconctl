import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
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
const icons = JSON.parse(await readFile(join(consumer, 'standalone-sprite.json'), 'utf8'))
const source = `\uFEFF${JSON.stringify(icons)}`
const exec = promisify(execFile)
const fixture = await realpath(await mkdtemp(join(consumer, 'sprite-')))
const completed = []
async function scenario(name, action) {
  const cwd = join(fixture, name)
  await mkdir(cwd)
  const input = join(cwd, 'icons.json')
  await writeFile(input, source)
  await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("local sprite must not execute configuration")')
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
    const result = await exec(process.execPath, [join(consumer, 'node_modules/iconctl/bin/index.js'), 'sprite', ...args, '--json'], {
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
  await scenario('public-sprite-api-and-facade', async (cwd, input) => {
    assert.equal(core.renderSvgSprite, facade.renderSvgSprite)
    assert.equal(core.writeSvgSprite, facade.writeSvgSprite)
    const expected = await core.renderSvgSprite(icons)
    const output = join(cwd, 'reports', 'sprite.svg')
    assert.deepEqual(await core.writeSvgSprite(output, icons), { prefix: 'brand', count: 8 })
    assert.equal(await readFile(output, 'utf8'), expected)
    await writeFile(output, 'previous report')
    assert.deepEqual(await facade.writeSvgSprite(output, icons, { inputs: [input] }), { prefix: 'brand', count: 8 })
    assert.equal(await readFile(output, 'utf8'), expected)
    assert.equal((expected.match(/<symbol /g) ?? []).length, 8)
    assert.deepEqual(await readdir(join(cwd, 'reports')), ['sprite.svg'])
  })
  await scenario('public-sprite-dry-run', async (cwd, input) => {
    const before = await readdir(cwd)
    assert.deepEqual(await facade.writeSvgSprite(join(cwd, 'new', 'sprite.svg'), icons, { inputs: [input], dryRun: true }), { prefix: 'brand', count: 8 })
    await assert.rejects(core.writeSvgSprite(join(cwd, 'new', 'invalid.svg'), { ...icons, aliases: { broken: { parent: 'missing' } } }, { dryRun: true }), core.IconctlError)
    assert.deepEqual(await readdir(cwd), before)
  })
  await scenario('public-sprite-source-protection', async (cwd, input) => {
    const hardlink = join(cwd, 'hardlink.svg')
    const alias = join(cwd, 'alias')
    const linkedInput = join(cwd, 'linked-input.json')
    await link(input, hardlink)
    await symlink(cwd, alias)
    await symlink(input, linkedInput)
    for (const dryRun of [false, true]) {
      for (const output of [input, hardlink, join(alias, 'icons.json')]) {
        await assert.rejects(facade.writeSvgSprite(output, icons, { inputs: [linkedInput], dryRun }), /conflicts with input/)
      }
      await assert.rejects(facade.writeSvgSprite(linkedInput, icons, { dryRun }), /regular file/)
    }
  })
  await scenario('packaged-sprite-local-input', async (cwd, input) => {
    const result = await cli(cwd, '--input', input, '--output', 'reports/local.svg')
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), { input: { file: input, prefix: 'brand' }, count: 8, outputFiles: [join(cwd, 'reports/local.svg')] })
    assert.equal(await readFile(join(cwd, 'reports/local.svg'), 'utf8'), await core.renderSvgSprite(icons))
    assert.deepEqual(await readdir(cwd), ['iconctl.config.mjs', 'icons.json', 'reports'])
    await rm(join(cwd, 'iconctl.config.mjs'))
    const defaultResult = await cli(cwd, '--input', 'icons.json')
    assert.equal(defaultResult.code, 0)
    assert.equal(defaultResult.stderr, '')
    assert.deepEqual(JSON.parse(defaultResult.stdout).outputFiles, [join(cwd, 'icons.svg')])
  })
  await scenario('packaged-sprite-dry-run', async (cwd, input) => {
    const before = await readdir(cwd)
    const result = await cli(cwd, '--input', 'icons.json', '--output', 'new/sprite.svg', '--dry-run')
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), { input: { file: input, prefix: 'brand' }, count: 8, outputFiles: [], dryRun: true })
    assert.deepEqual(await readdir(cwd), before)
  })
  await scenario('packaged-sprite-failure-boundary', async (cwd) => {
    await writeFile(join(cwd, 'icons.svg'), 'previous sprite')
    await writeFile(join(cwd, 'invalid.json'), '{')
    await writeFile(join(cwd, 'unsupported.json'), JSON.stringify({ prefix: 'brand', icons: { bad: { body: '<path style="fill:red"/>' } } }))
    for (const [args, phase] of [
      [[], 'arguments'],
      [['--input'], 'arguments'],
      [['--input', 'icons.json', '--config', 'unused.mjs'], 'arguments'],
      [['--input', 'icons.json', '--continue'], 'arguments'],
      [['--input', 'icons.json', '--input', 'again.json'], 'arguments'],
      [['--input', 'invalid.json'], 'execution'],
      [['--input', 'unsupported.json'], 'execution'],
      [['--input', 'unsupported.json', '--dry-run'], 'execution'],
      [['--input', 'icons.json', '--output', 'icons.json', '--dry-run'], 'execution'],
    ]) {
      const result = await cli(cwd, ...args)
      assert.equal(result.code, 1)
      assert.equal(result.stderr, '')
      const report = JSON.parse(result.stdout)
      assert.equal(report.success, false)
      assert.equal(report.command, 'sprite')
      assert.equal(report.error.phase, phase)
      assert.equal('valid' in report, false)
      assert.equal(await readFile(join(cwd, 'icons.svg'), 'utf8'), 'previous sprite')
    }
  })
  const svg = await core.renderSvgSprite(icons)
  console.log(JSON.stringify({ mode, runtime: process.version, scenarios: completed, svgBytes: Buffer.byteLength(svg), svgSha256: createHash('sha256').update(svg).digest('hex'), passed: true }))
}
finally {
  await rm(fixture, { recursive: true, force: true })
}
