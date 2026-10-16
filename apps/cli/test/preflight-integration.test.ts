import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { runCli } from '../src/program'

describe('Figma naming preflight through the real CLI pipeline', () => {
  let cwd: string
  let previous: string
  let output: string
  let requests: string[]
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'iconctl-preflight-cli-'))
    previous = process.cwd()
    process.chdir(cwd)
    process.exitCode = 0
    output = ''
    requests = []
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      output += String(text)
      return true
    })
    await writeFile(join(cwd, 'icons.json'), JSON.stringify({ prefix: 'brand', icons: { bell: { body: '<path/>' }, retired: { body: '<path/>' } } }))
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(input)
      requests.push(url.pathname)
      if (!url.pathname.startsWith('/v1/files/')) {
        throw new Error(`Preflight unexpectedly requested SVGs: ${url.pathname}`)
      }
      return Response.json({
        name: 'Icons',
        editorType: 'figma',
        version: 'v1',
        lastModified: '2026-10-16T00:00:00Z',
        document: {
          id: '0:0',
          name: 'Document',
          type: 'DOCUMENT',
          children: [{
            id: '0:1',
            name: 'Icons',
            type: 'CANVAS',
            children: ['1:2', '1:3'].map(id => ({ id, name: 'Bell', type: 'COMPONENT', absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 }, children: [] })),
          }],
        },
      })
    }))
  })
  afterEach(async () => {
    process.chdir(previous)
    process.exitCode = 0
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await rm(cwd, { recursive: true, force: true })
  })

  async function configure(duplicates: 'error' | 'suffix-node-id', mixed = false) {
    await writeFile(join(cwd, 'iconctl.config.mjs'), `export default ${JSON.stringify({
      prefix: 'brand',
      sources: [
        { type: 'figma', file: 'AbCdEfGhIjKlMnOpQrStUv', token: 'pat', naming: { duplicates } },
        ...(mixed ? [{ type: 'directory', dir: 'does-not-exist' }] : []),
      ],
      output: { json: 'icons.json', svg: 'generated-svg', preview: 'preview.html' },
    })}`)
  }

  it.each(['error', 'suffix-node-id'] as const)('reports %s naming without requesting SVGs or writing outputs and manifest', async (duplicates) => {
    await configure(duplicates)
    const before = await readFile(join(cwd, 'icons.json'), 'utf8')
    await runCli(['node', 'iconctl', 'preflight', '--json'])
    const report = JSON.parse(output)
    expect(report.complete).toBe(duplicates !== 'error')
    expect(process.exitCode).toBe(duplicates === 'error' ? 1 : 0)
    expect(report.issues).toHaveLength(2)
    expect(report.issues[0]).toMatchObject({
      code: duplicates === 'error' ? 'FIGMA_DUPLICATE_NAME' : 'FIGMA_NAME_DISAMBIGUATED',
      severity: duplicates === 'error' ? 'error' : 'warning',
      originalName: 'Bell',
      normalizedName: 'bell',
      nodeId: '1:2',
    })
    expect(report.naming[0].mappings).toHaveLength(2)
    expect(report.outputFiles).toEqual([])
    expect(requests).toEqual(['/v1/files/AbCdEfGhIjKlMnOpQrStUv'])
    expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe(before)
    for (const file of ['.iconctl-names.json', 'generated-svg', 'preview.html']) {
      await expect(readFile(join(cwd, file))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    if (duplicates === 'suffix-node-id') {
      expect(report.naming[0].mappings.map((mapping: { name: string }) => mapping.name)).toEqual(['bell', 'bell-1-3'])
      expect(report.publicNames).toEqual({ added: ['bell-1-3'], removed: ['retired'], deletionsReliable: true })
    }
  })

  it('skips local sources and never claims reliable public-name deletions for a mixed config', async () => {
    await configure('suffix-node-id', true)
    await runCli(['node', 'iconctl', 'preflight', '--json'])
    const report = JSON.parse(output)
    expect(report.complete).toBe(true)
    expect(report.naming).toHaveLength(1)
    expect(report.publicNames).toEqual({ added: ['bell-1-3'], removed: [], deletionsReliable: false })
    expect(process.exitCode).toBe(0)
    expect(requests).toEqual(['/v1/files/AbCdEfGhIjKlMnOpQrStUv'])
  })
})
