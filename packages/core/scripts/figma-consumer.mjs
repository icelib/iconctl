import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const mode = process.argv[2]
assert(['esm', 'cjs'].includes(mode), 'Expected the consumer mode: esm or cjs')
const core = mode === 'cjs' ? createRequire(import.meta.url)('@iconctl/core') : await import('@iconctl/core')
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-figma-consumer-')))
const originalFetch = globalThis.fetch
const fileKey = 'AbCdEfGhIjKlMnOpQrStUv'
const lastModified = '2026-10-04T00:00:00Z'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
const icons = [
  { id: '1:1', name: 'Arrow Left' },
  { id: '1:2', name: 'arrow_left' },
  { id: '1:3', name: 'Check' },
]

function configure(naming) {
  return core.resolveConfig({
    prefix: 'brand',
    sources: [{ type: 'figma', file: fileKey, token: 'fixture', ...(naming ? { naming } : {}) }],
    output: { json: 'icons.json', types: 'types.ts', changelog: 'CHANGELOG.md' },
  })
}

async function project(name, selected = icons) {
  const cwd = join(fixture, name)
  await mkdir(cwd)
  const requests = { imageBatches: [], downloads: [], documentDepths: [] }
  globalThis.fetch = async (input) => {
    const url = new URL(input)
    if (url.hostname === 'cdn.example.com') {
      requests.downloads.push(decodeURIComponent(url.pathname.slice(1)))
      return new Response(svg)
    }
    if (url.pathname.includes('/files/')) {
      requests.documentDepths.push(url.searchParams.get('depth'))
      return Response.json({
        editorType: 'figma',
        version: 'v1',
        lastModified,
        document: { id: '0:0', type: 'DOCUMENT', children: [{
          id: '0:1',
          name: 'Icons',
          type: 'CANVAS',
          children: selected.map(icon => ({
            ...icon,
            type: 'COMPONENT',
            children: [],
            absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
          })),
        }] },
      })
    }
    if (url.pathname.includes('/images/')) {
      const ids = url.searchParams.get('ids').split(',')
      requests.imageBatches.push(ids)
      return Response.json({ images: Object.fromEntries(ids.map(id => [id, `https://cdn.example.com/${encodeURIComponent(id)}`])) })
    }
    throw new Error(`Unexpected request: ${url.href}`)
  }
  const json = { prefix: 'brand', width: 24, height: 24, icons: { 'arrow-left': { body: '<path d="M0 0h24v24H0z"/>' }, 'check': { body: '<path d="M0 0h24v24H0z"/>' } } }
  const previous = {
    'icons.json': JSON.stringify(json),
    'types.ts': 'export type Previous = "arrow-left" | "check"\n',
    'CHANGELOG.md': '# Previous changes\n',
  }
  for (const [file, content] of Object.entries(previous)) {
    await writeFile(join(cwd, file), content)
  }
  return { cwd, config: configure(), requests, previous, json }
}

function checkIssues(issues, resolved = false) {
  assert.deepEqual(issues.map(({ message, ...coordinates }) => {
    assert.equal(typeof message, 'string')
    assert(message.length > 0)
    return coordinates
  }), ['1:1', '1:2'].map(nodeId => ({
    name: 'arrow-left',
    nodeId,
    fileKey,
    sourceType: 'figma',
    sourceIndex: 0,
    stage: 'import',
    code: resolved ? 'FIGMA_NAME_DISAMBIGUATED' : 'FIGMA_DUPLICATE_NAME',
    severity: resolved ? 'warning' : 'error',
    collisionGroup: 'arrow-left',
    originalName: icons.find(icon => icon.id === nodeId).name,
    normalizedName: 'arrow-left',
    parentPath: ['Icons'],
    figmaUrl: `https://www.figma.com/design/${fileKey}?node-id=${encodeURIComponent(nodeId)}`,
    proposedName: nodeId === '1:1' ? 'arrow-left' : 'arrow-left-1-2',
  })))
}

async function rejected(task) {
  await assert.rejects(task, (error) => {
    assert(error instanceof core.IconctlSyncError, 'Conflicts must reject with the public IconctlSyncError')
    checkIssues(error.issues)
    return true
  })
}

async function unchanged({ cwd, previous }) {
  for (const [file, content] of Object.entries(previous)) {
    assert.equal(await readFile(join(cwd, file), 'utf8'), content)
  }
}

function onlyIndependentRendered(requests) {
  assert.deepEqual(requests.imageBatches, [['1:3']])
  assert.deepEqual(requests.downloads, ['1:3'])
}

try {
  const normal = await project('default')
  await rejected(core.sync({ cwd: normal.cwd, config: normal.config }))
  await unchanged(normal)
  onlyIndependentRendered(normal.requests)

  const partial = await project('continue')
  const result = await core.sync({ cwd: partial.cwd, config: partial.config, continueOnError: true })
  assert.equal(result.complete, false)
  assert.equal(result.notModified, false)
  assert.equal(result.diff.deletionsReliable, false)
  assert.deepEqual(result.diff.removed, [])
  assert.deepEqual(result.failed, ['arrow-left'])
  checkIssues(result.issues)
  assert.deepEqual(Object.keys(result.json.icons), ['check'])
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(partial.cwd, 'icons.json'), 'utf8')).icons), ['check'])
  assert.equal(await readFile(join(partial.cwd, 'CHANGELOG.md'), 'utf8'), partial.previous['CHANGELOG.md'])
  await assert.rejects(readFile(join(partial.cwd, partial.config.cacheDir, 'meta.json')), { code: 'ENOENT' })
  onlyIndependentRendered(partial.requests)

  const all = await project('all-conflicting', icons.slice(0, 2))
  await rejected(core.sync({ cwd: all.cwd, config: all.config, continueOnError: true }))
  await unchanged(all)
  assert.deepEqual(all.requests.imageBatches, [])
  assert.deepEqual(all.requests.downloads, [])

  const legacy = await project('legacy-completion')
  const configDigest = createHash('sha256').update(JSON.stringify(legacy.config, (key, value) =>
    key === 'token'
      ? undefined
      : typeof value === 'function' || value instanceof RegExp
        ? String(value)
        : value)).digest('hex')
  // A previous release accepted these colliding nodes and marked this output
  // complete. Matching config/output and remote revision must not skip the new
  // importer validation when the semantic validation version is absent.
  const metadata = JSON.stringify({
    configDigest,
    outputDigest: createHash('sha256').update(JSON.stringify(legacy.json)).digest('hex'),
    lastModified,
    version: 'v1',
  })
  const metaFile = join(legacy.cwd, legacy.config.cacheDir, 'meta.json')
  await mkdir(join(legacy.cwd, legacy.config.cacheDir), { recursive: true })
  await writeFile(metaFile, metadata)
  await rejected(core.sync({ cwd: legacy.cwd, config: legacy.config }))
  await unchanged(legacy)
  assert.equal(await readFile(metaFile, 'utf8'), metadata)
  assert.deepEqual(legacy.requests.documentDepths, ['3'])
  onlyIndependentRendered(legacy.requests)

  const stable = await project('stable-naming')
  const stableConfig = configure({ duplicates: 'suffix-node-id' })
  const preview = await core.preflightFigmaNaming({ cwd: stable.cwd, config: stableConfig })
  assert.equal(preview.complete, true)
  checkIssues(preview.issues, true)
  assert.deepEqual(preview.files, [])
  assert.deepEqual(preview.publicNames, { added: ['arrow-left-1-2'], removed: [], deletionsReliable: true })
  assert.deepEqual(preview.naming[0].mappings.map(({ nodeId, name }) => ({ nodeId, name })), [
    { nodeId: '1:1', name: 'arrow-left' },
    { nodeId: '1:2', name: 'arrow-left-1-2' },
    { nodeId: '1:3', name: 'check' },
  ])
  assert.deepEqual(stable.requests.imageBatches, [])
  assert.deepEqual(stable.requests.downloads, [])
  assert.deepEqual(stable.requests.documentDepths, ['3'])
  await unchanged(stable)
  await assert.rejects(readFile(join(stable.cwd, '.iconctl-names.json')), { code: 'ENOENT' })
  const dry = await core.sync({ cwd: stable.cwd, config: stableConfig, dryRun: true })
  assert.equal(dry.complete, true)
  assert.deepEqual(dry.naming, preview.naming)
  await unchanged(stable)
  await assert.rejects(readFile(join(stable.cwd, '.iconctl-names.json')), { code: 'ENOENT' })
  const imported = await core.sync({ cwd: stable.cwd, config: stableConfig })
  assert.equal(imported.complete, true)
  assert.deepEqual(imported.failed, [])
  checkIssues(imported.issues, true)
  assert.deepEqual(Object.keys(imported.json.icons).sort(), ['arrow-left', 'arrow-left-1-2', 'check'])
  const saved = JSON.parse(await readFile(join(stable.cwd, '.iconctl-names.json'), 'utf8'))
  assert.equal(saved.sources[JSON.stringify([fileKey, ''])].entries['1:1'].name, 'arrow-left')
  assert.equal(saved.sources[JSON.stringify([fileKey, ''])].entries['1:2'].name, 'arrow-left-1-2')
  assert.equal((await core.sync({ cwd: stable.cwd, config: stableConfig })).notModified, true)

  console.log(JSON.stringify({ mode, runtime: process.version, scenarios: 5, stableNaming: true, documentOnlyPreflight: true, passed: true }))
}
finally {
  globalThis.fetch = originalFetch
  await rm(fixture, { recursive: true, force: true })
}
