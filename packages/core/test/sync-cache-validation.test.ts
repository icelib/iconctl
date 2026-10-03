import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconctlSyncError, resolveConfig, sync } from '../src'

const fileKey = 'AbCdEfGhIjKlMnOpQrStUv'
const config = resolveConfig({
  prefix: 'brand',
  sources: [{ type: 'figma', file: fileKey, token: 'fixture' }],
  output: { json: 'icons.json', changelog: 'CHANGELOG.md' },
})
const previous = { prefix: 'brand', width: 24, height: 24, icons: {
  'arrow-left': { body: '<path d="M0 0h20v24H0z"/>' },
  'home': { body: '<path d="M0 0h24v24H0z"/>' },
} }
let cwd: string
let repaired: boolean
let depths: string[]
const metaPath = () => join(cwd, config.cacheDir, 'meta.json')
async function seedLegacy(validationVersion?: number) {
  // The pre-validation-version completion format could certify a silently
  // overwritten icon. Keep its old digests valid to exercise the upgrade gate.
  const configDigest = createHash('sha256').update(JSON.stringify(config, (key, value) =>
    key === 'token' ? undefined : typeof value === 'function' || value instanceof RegExp ? String(value) : value)).digest('hex')
  await mkdir(join(cwd, config.cacheDir), { recursive: true })
  await writeFile(join(cwd, 'icons.json'), JSON.stringify(previous))
  await writeFile(join(cwd, 'CHANGELOG.md'), 'previous changelog')
  await writeFile(metaPath(), JSON.stringify({
    configDigest,
    outputDigest: createHash('sha256').update(JSON.stringify(previous)).digest('hex'),
    lastModified: 'unchanged-revision',
    version: 'v1',
    ...(validationVersion === undefined ? {} : { validationVersion }),
  }))
}
async function snapshot() {
  return await Promise.all(['icons.json', 'CHANGELOG.md', `${config.cacheDir}/meta.json`].map(file => readFile(join(cwd, file), 'utf8')))
}
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'iconctl-validation-cache-'))
  repaired = false
  depths = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname.includes('/files/')) {
      depths.push(url.searchParams.get('depth')!)
      return Response.json({
        editorType: 'figma',
        version: 'v1',
        lastModified: 'unchanged-revision',
        document: { id: '0:0', type: 'DOCUMENT', children: [{
          id: '0:1',
          name: 'Icons',
          type: 'CANVAS',
          children: ['Arrow Left', repaired ? 'arrow_right' : 'arrow_left', 'home'].map((name, index) => ({
            id: `1:${index + 1}`,
            name,
            type: 'COMPONENT',
            children: [],
            absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
          })),
        }] },
      })
    }
    if (url.pathname.includes('/images/')) {
      return Response.json({ images: Object.fromEntries(url.searchParams.get('ids')!.split(',').map(id => [id, `https://cdn.example.com/${id}.svg`])) })
    }
    return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>')
  }))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(cwd, { recursive: true, force: true })
})

it.each([undefined, 0, 999])('revalidates an unchanged document with completion validation version %s', async (version) => {
  await seedLegacy(version)
  const before = await snapshot()
  await expect(sync({ cwd, config })).rejects.toBeInstanceOf(IconctlSyncError)
  expect(depths).toEqual(['3'])
  expect(await snapshot()).toEqual(before)
  // A rejected old completion marker stays untrusted on subsequent attempts.
  await expect(sync({ cwd, config })).rejects.toBeInstanceOf(IconctlSyncError)
  expect(depths).toEqual(['3', '3'])
  expect(await snapshot()).toEqual(before)
})

it.each([false, true])('reports collisions from an old completion marker with continue (dry run: %s)', async (dryRun) => {
  await seedLegacy()
  const before = await snapshot()
  const result = await sync({ cwd, config, continueOnError: true, dryRun })
  expect(result).toMatchObject({ complete: false, notModified: false, failed: ['arrow-left'], diff: { removed: [], deletionsReliable: false } })
  expect(result.issues.map(issue => ({ name: issue.name, nodeId: issue.nodeId, stage: issue.stage }))).toEqual([
    { name: 'arrow-left', nodeId: '1:1', stage: 'import' },
    { name: 'arrow-left', nodeId: '1:2', stage: 'import' },
  ])
  expect(Object.keys(result.json.icons)).toEqual(['home'])
  expect(depths).toEqual(['3'])
  if (dryRun) {
    expect(result.files).toEqual([])
    expect(await snapshot()).toEqual(before)
  }
  else {
    expect(JSON.parse(await readFile(join(cwd, 'icons.json'), 'utf8')).icons).not.toHaveProperty('arrow-left')
    expect(await readFile(join(cwd, 'CHANGELOG.md'), 'utf8')).toBe('previous changelog')
    await expect(readFile(metaPath())).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

it('reuses a completion marker only after successful revalidation and publication', async () => {
  await seedLegacy()
  await expect(sync({ cwd, config })).rejects.toBeInstanceOf(IconctlSyncError)
  repaired = true
  const result = await sync({ cwd, config })
  expect(result).toMatchObject({ complete: true, notModified: false, issues: [] })
  expect(Object.keys(result.json.icons).sort()).toEqual(['arrow-left', 'arrow-right', 'home'])
  const meta = JSON.parse(await readFile(metaPath(), 'utf8'))
  expect(meta).toMatchObject({ validationVersion: 1, version: 'v1' })
  expect((await sync({ cwd, config })).notModified).toBe(true)
  expect(depths).toEqual(['3', '3', '1'])
})
