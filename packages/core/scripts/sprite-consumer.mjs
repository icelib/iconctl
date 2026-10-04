import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { IconSet } from '@iconify/tools'
import { SaxesParser } from 'saxes'

const mode = process.argv[2]
assert(['esm', 'cjs'].includes(mode), 'Expected the consumer mode: esm or cjs')
const consumer = await realpath(fileURLToPath(new URL('.', import.meta.url)))
const require = createRequire(import.meta.url)
const entry = mode === 'cjs' ? require.resolve('@iconctl/core') : fileURLToPath(import.meta.resolve('@iconctl/core'))
assert((await realpath(entry)).startsWith(join(consumer, 'node_modules')))
const core = mode === 'cjs' ? require('@iconctl/core') : await import('@iconctl/core')

const exec = promisify(execFile)

const quotedBody = `
  <title id='label'>O&apos;Brien &amp; Co</title>
  <defs><linearGradient id='paint'><stop offset='0' stop-color='currentColor'/></linearGradient></defs>
  <g aria-labelledby='label' data-label='A &amp; B &quot;quoted&quot;' opacity='0'>
    <path id='shape' fill='url( &quot;#paint&quot; )' d='M0 0h12v8H0z'/>
    <use href='&#35;shape'/><use xlink:href='#shape'/>
    <text x='0' y='0'>A &amp; B<tspan>nested &lt;inner&gt;</tspan> tail &quot;quote&quot;</text>
  </g>
`
const shape = '<path fill="currentColor" d="M0 0h12v8H0z"/>'

function icons(reverse = false, body = quotedBody) {
  const entries = [['home', { body }], ['zulu', { body: shape }]]
  return new IconSet({
    prefix: 'brand',
    width: 32,
    height: 16,
    left: -2,
    top: 3,
    icons: Object.fromEntries(reverse ? entries.toReversed() : entries),
    aliases: { rotated: { parent: 'home', rotate: 1 }, pure: { parent: 'home' } },
  })
}

function config(output = {}) {
  return core.resolveConfig(core.defineConfig({
    prefix: 'brand',
    sources: [{ type: 'directory', dir: 'raw' }],
    color: false,
    output: { json: 'icons.json', sprite: 'sprite.svg', types: 'icons.d.ts', ...output },
  }))
}

function parse(xml) {
  const roots = []
  const stack = []
  const parser = new SaxesParser({ xmlns: true })
  parser.on('opentag', (tag) => {
    const node = { name: tag.name, namespace: tag.uri, attributes: Object.fromEntries(Object.entries(tag.attributes).map(([name, value]) => [name, value.value])), children: [] }
    const parent = stack.at(-1)
    if (parent) {
      parent.children.push(node)
    }
    else {
      roots.push(node)
    }
    stack.push(node)
  })
  parser.on('text', text => stack.at(-1)?.children.push(text))
  parser.on('closetag', () => stack.pop())
  parser.write(xml).close()
  assert.equal(roots.length, 1)
  assert.equal(roots[0].name, 'svg')
  assert.equal(roots[0].namespace, 'http://www.w3.org/2000/svg')
  return roots[0]
}

function elements(node) {
  return [node, ...node.children.flatMap(child => typeof child === 'string' ? [] : elements(child))]
}

function text(node) {
  return node.children.map(child => typeof child === 'string' ? child : text(child)).join('')
}

function inspectSprite(xml) {
  const root = parse(xml)
  const symbols = root.children.filter(child => typeof child !== 'string')
  assert(symbols.every(symbol => symbol.name === 'symbol'))
  assert.deepEqual(symbols.map(symbol => symbol.attributes.id), ['home', 'pure', 'rotated', 'zulu'].map(name => `iconctl-brand-${name}`))
  const byId = new Map(symbols.map(symbol => [symbol.attributes.id, symbol]))
  assert.equal(byId.get('iconctl-brand-home').attributes.viewBox, '-2 3 32 16')
  assert.equal(byId.get('iconctl-brand-pure').attributes.viewBox, '-2 3 32 16')
  assert.equal(byId.get('iconctl-brand-rotated').attributes.viewBox, '3 -2 16 32')
  const ids = elements(root).flatMap(node => node.attributes.id === undefined ? [] : [node.attributes.id])
  assert.equal(new Set(ids).size, ids.length, 'IDs must be unique across the whole sprite')
  for (const name of ['home', 'pure', 'rotated']) {
    const symbol = byId.get(`iconctl-brand-${name}`)
    const nodes = elements(symbol)
    const local = new Set(nodes.map(node => node.attributes.id).filter(Boolean))
    const title = nodes.find(node => node.name === 'title')
    assert.equal(text(title), 'O\'Brien & Co')
    const group = nodes.find(node => node.attributes['data-label'] !== undefined)
    assert.equal(group.attributes['data-label'], 'A & B "quoted"')
    assert.equal(group.attributes.opacity, '0')
    assert.equal(group.attributes['aria-labelledby'], title.attributes.id)
    const label = nodes.find(node => node.name === 'text')
    assert.equal(text(label), 'A & Bnested <inner> tail "quote"')
    assert.deepEqual(label.children.map(child => typeof child === 'string' ? child : child.name), ['A & B', 'tspan', ' tail "quote"'])
    assert.equal(nodes.find(node => node.name === 'stop').attributes['stop-color'], 'currentColor')
    for (const node of nodes) {
      for (const [attribute, value] of Object.entries(node.attributes)) {
        if (attribute === 'href' || attribute === 'xlink:href') {
          assert(local.has(value.slice(1)), `${attribute} must resolve within its own symbol`)
        }
        if (value.startsWith('url(#')) {
          assert(local.has(value.slice(5, -1)), 'Paint must resolve within its own symbol')
        }
      }
    }
  }
  assert.equal(elements(byId.get('iconctl-brand-zulu')).find(node => node.name === 'path').attributes.fill, 'currentColor')
}

async function tree(directory) {
  const entries = []
  const visit = async (path, prefix) => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const relative = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        entries.push([`${relative}/`, 'directory'])
        await visit(join(path, entry.name), `${relative}/`)
      }
      else {
        assert(entry.isFile(), 'Consumer fixtures contain only regular files and directories')
        entries.push([relative, (await readFile(join(path, entry.name))).toString('base64')])
      }
    }
  }
  await visit(directory, '')
  return entries
}

if (process.argv[3] === 'render') {
  const cwd = process.argv[4]
  await core.exportOutputs(icons(process.argv[5] === 'reverse'), config(), { cwd })
  process.stdout.write(JSON.stringify({ pid: process.pid, sprite: await readFile(join(cwd, 'sprite.svg'), 'utf8') }))
}
else {
  const fixture = await realpath(await mkdtemp(join(consumer, 'sprite-')))
  const completed = []
  const scenario = async (name, action) => {
    const cwd = join(fixture, name)
    await mkdir(cwd)
    await action(cwd)
    completed.push(name)
  }
  try {
    await scenario('public-export-preserves-xml-and-aliases', async (cwd) => {
      const result = await core.exportOutputs(icons(), config(), { cwd })
      assert.deepEqual(result.files, ['icons.json', 'sprite.svg', 'icons.d.ts'].map(file => join(cwd, file)))
      inspectSprite(await readFile(join(cwd, 'sprite.svg'), 'utf8'))
      assert((await readFile(join(cwd, 'icons.d.ts'), 'utf8')).includes('export type IconName = \'home\' | \'pure\' | \'rotated\' | \'zulu\''))
      assert.deepEqual((await readdir(cwd)).sort(), ['icons.d.ts', 'icons.json', 'sprite.svg'])
    })

    await scenario('public-sync-publishes-sprite', async (cwd) => {
      const result = await core.sync({ cwd, config: config({ preview: 'preview.html' }), iconSet: icons(false, shape) })
      assert.equal(result.complete, true)
      assert.deepEqual(result.failed, [])
      assert.deepEqual(result.files, ['icons.json', 'sprite.svg', 'icons.d.ts', 'preview.html'].map(file => join(cwd, file)))
      const sprite = parse(await readFile(join(cwd, 'sprite.svg'), 'utf8'))
      assert.deepEqual(sprite.children.filter(child => typeof child !== 'string').map(symbol => symbol.attributes.id), ['home', 'pure', 'rotated', 'zulu'].map(name => `iconctl-brand-${name}`))
      assert(elements(sprite).some(node => node.attributes.fill === 'currentColor'))
      assert.equal((await readdir(cwd)).some(name => name.startsWith('.iconctl-stage-')), false)
    })

    await scenario('deterministic-across-fresh-processes', async (cwd) => {
      const rendered = []
      for (const order of ['forward', 'reverse']) {
        const directory = join(cwd, order)
        await mkdir(directory)
        const { stdout } = await exec(process.execPath, [fileURLToPath(import.meta.url), mode, 'render', directory, order], { cwd: consumer, timeout: 20000, maxBuffer: 1024 * 1024 })
        rendered.push(JSON.parse(stdout))
      }
      assert.notEqual(rendered[0].pid, rendered[1].pid)
      assert(rendered.every(result => result.pid !== process.pid))
      assert.equal(rendered[0].sprite, rendered[1].sprite)
      inspectSprite(rendered[0].sprite)
    })

    await scenario('unsupported-static-preserves-all-outputs', async (cwd) => {
      const cfg = config({ svg: 'svg' })
      await core.exportOutputs(icons(false, shape), cfg, { cwd })
      const before = await tree(cwd)
      for (const body of [
        '<path fill="url(#missing)"/>',
        '<use href="https://example.invalid/icons.svg#remote"/>',
        '<path id="a"/><path id="a"/>',
        '<path onload=\'alert(1)\'/>',
        '<path style="fill:red"/>',
        '<style>path{fill:red}</style>',
        '<animate attributeName="opacity" dur="1s"/>',
        '<foreignObject><div/></foreignObject>',
        '<text>&unknown;</text>',
      ]) {
        const set = new IconSet({ prefix: 'brand', icons: { home: { body } } })
        await assert.rejects(core.exportOutputs(set, cfg, { cwd }), (error) => {
          assert(error instanceof core.IconctlError)
          assert.match(error.message, /SVG sprite icon "brand:home"/)
          return true
        })
        assert.deepEqual(await tree(cwd), before, `Failed sprite must preserve prior outputs: ${body}`)
      }
    })

    await scenario('dry-run-validates-without-writes', async (cwd) => {
      const cfg = config({ svg: 'svg', preview: 'preview.html' })
      const before = await tree(cwd)
      const exported = await core.exportOutputs(icons(), cfg, { cwd, dryRun: true })
      assert.deepEqual(exported.files, [])
      assert.deepEqual(await tree(cwd), before)
      const synced = await core.sync({ cwd, config: cfg, iconSet: icons(false, shape), dryRun: true })
      assert.equal(synced.complete, true)
      assert.deepEqual(synced.files, [])
      assert.deepEqual(await tree(cwd), before)
      await assert.rejects(core.exportOutputs(new IconSet({ prefix: 'brand', icons: { home: { body: '<use href="#missing"/>' } } }), cfg, { cwd, dryRun: true }), core.IconctlError)
      assert.deepEqual(await tree(cwd), before)
    })

    console.log(JSON.stringify({ mode, runtime: process.version, scenarios: completed, passed: true }))
  }
  finally {
    await rm(fixture, { recursive: true, force: true })
  }
}
