import type { FigmaSourceConfig } from '../src/sources/types'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preflightFigmaNaming, resolveConfig, sync } from '../src'

const fileKey = 'AbCdEfGhIjKlMnOpQrStUv'
let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'iconctl-preflight-empty-'))
  await writeFile(join(cwd, 'icons.json'), JSON.stringify({
    prefix: 'brand',
    icons: { bell: { body: '<path d="M0 0h24v24H0z"/>', width: 24, height: 24 } },
  }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(cwd, { recursive: true, force: true })
})

function config(source: Partial<FigmaSourceConfig> = {}) {
  return resolveConfig({
    prefix: 'brand',
    sources: [{ type: 'figma', file: fileKey, token: 'fixture', ...source }],
    output: { json: 'icons.json' },
  })
}

function mockFigma(names: string[]) {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(input)
    requests.push(url.pathname)
    if (!url.pathname.includes('/files/')) {
      throw new Error(`Unexpected request: ${url.href}`)
    }
    return Response.json({
      editorType: 'figma',
      version: 'v1',
      lastModified: '2026-10-16T00:00:00Z',
      document: {
        id: '0:0',
        type: 'DOCUMENT',
        children: [{
          id: '0:1',
          name: 'Icons',
          type: 'CANVAS',
          children: names.map((name, index) => ({
            id: `1:${index + 1}`,
            name,
            type: 'COMPONENT',
            children: [],
            absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
          })),
        }],
      },
    })
  }))
  return requests
}

it.each(['empty', 'drafts', 'pages', 'transform'] as const)('rejects an empty %s selection without claiming reliable deletions', async (selection) => {
  const requests = mockFigma(selection === 'empty' ? [] : selection === 'drafts' ? ['_draft', '.draft'] : ['bell'])
  const resolved = config(selection === 'pages'
    ? { pages: ['Other page'] }
    : selection === 'transform' ? { naming: { transform: () => null } } : {})
  const result = await preflightFigmaNaming({ cwd, config: resolved })
  expect(result).toMatchObject({ complete: false, publicNames: { removed: [], deletionsReliable: false }, files: [] })
  expect(result.issues).toEqual([expect.objectContaining({
    code: 'FIGMA_NO_ICON_CANDIDATES',
    severity: 'error',
    stage: 'import',
    sourceIndex: 0,
    sourceType: 'figma',
    fileKey,
  })])
  await expect(sync({ cwd, config: resolved, dryRun: true })).rejects.toThrow('No valid Figma icons could be imported')
  expect(requests.every(path => path.includes('/files/'))).toBe(true)
})

it('reports an empty Figma source at its configured index in a mixed-source project', async () => {
  mockFigma([])
  const resolved = config()
  resolved.sources.unshift({ type: 'directory', dir: 'not-loaded-during-preflight' })
  const result = await preflightFigmaNaming({ cwd, config: resolved })
  expect(result.complete).toBe(false)
  expect(result.publicNames).toEqual({ added: [], removed: [], deletionsReliable: false })
  expect(result.issues).toEqual([expect.objectContaining({ code: 'FIGMA_NO_ICON_CANDIDATES', sourceIndex: 1 })])
})

it('keeps existing duplicate errors without adding a redundant empty-selection error', async () => {
  mockFigma(['bell', 'bell'])
  const result = await preflightFigmaNaming({ cwd, config: config() })
  expect(result.complete).toBe(false)
  expect(result.publicNames).toEqual({ added: [], removed: [], deletionsReliable: false })
  expect(result.issues).toHaveLength(2)
  expect(result.issues.every(issue => issue.code === 'FIGMA_DUPLICATE_NAME')).toBe(true)
})
