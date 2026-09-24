import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, sync } from '../src'
import { loadFigmaSource } from '../src/sources/figma'

function component(id: string, name: string) {
  return {
    id,
    name,
    type: 'COMPONENT',
    absoluteBoundingBox: { width: 24, height: 24, x: 0, y: 0 },
    children: [],
  }
}
function document() {
  return {
    name: 'Icons',
    editorType: 'figma',
    version: 'v1',
    lastModified: '2026-09-24T00:00:00Z',
    document: {
      id: '0:0',
      name: 'Document',
      type: 'DOCUMENT',
      children: [
        {
          id: '0:1',
          name: 'Icons',
          type: 'CANVAS',
          children: [component('1:1', 'home'), component('1:2', '_draft')],
        },
        {
          id: '0:2',
          name: 'Other',
          type: 'CANVAS',
          children: [component('2:1', 'other')],
        },
      ],
    },
  }
}
const svg
  = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000" d="M3 10l9-7 9 7v10H3z"/></svg>'
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'iconctl-figma-'))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

it('syncs OAuth through file filtering, versioned SVG rendering, output and not-modified checks', async () => {
  const calls: string[] = []
  const request = vi.fn(async (input: string | URL, init: RequestInit) => {
    const url = new URL(input)
    calls.push(url.pathname)
    if (url.pathname.endsWith('/oauth/refresh')) {
      return Response.json({
        access_token: 'oauth-access',
        token_type: 'bearer',
        expires_in: 3600,
      })
    }
    if (url.hostname === 'cdn.example.com') {
      expect(init.headers).toBeUndefined()
      return new Response(svg)
    }
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer oauth-access',
    )
    if (url.pathname.includes('/files/')) {
      expect(url.searchParams.get('ids')).toBe('0:1')
      return Response.json(document())
    }
    expect(url.searchParams.get('ids')).toBe('1:1')
    expect(url.searchParams.get('version')).toBe('v1')
    return Response.json({
      images: { '1:1': 'https://cdn.example.com/home.svg' },
    })
  })
  vi.stubGlobal('fetch', request)
  const config = resolveConfig({
    prefix: 'brand',
    sources: [
      {
        type: 'figma',
        file: 'AbCdEfGhIjKlMnOpQrStUv',
        pages: ['Icons'],
        ids: ['0:1'],
      },
    ],
    output: { json: 'icons.json' },
  })
  const env = {
    FIGMA_CLIENT_ID: directory,
    FIGMA_CLIENT_SECRET: 'ci-secret',
    FIGMA_REFRESH_TOKEN: 'ci-refresh',
  }
  const first = await sync({ cwd: directory, config, env })
  expect(first.diff.added).toEqual(['home'])
  expect(
    (
      JSON.parse(await readFile(join(directory, 'icons.json'), 'utf8')) as {
        icons: Record<string, { body: string }>
      }
    ).icons['home']?.body,
  ).toContain('currentColor')
  const next = await sync({ cwd: directory, config, env })
  expect(next.notModified).toBe(true)
  expect(calls.filter(path => path.endsWith('/oauth/refresh'))).toHaveLength(
    1,
  )
  expect(calls.filter(path => path.includes('/images/'))).toHaveLength(1)
})

it('reuses caches and supports personal tokens and custom naming', async () => {
  const request = vi.fn(async (input: string | URL, init: RequestInit) => {
    const url = String(input)
    if (url.includes('/files/')) {
      expect(new Headers(init.headers).get('X-Figma-Token')).toBe('pat')
      return Response.json(document())
    }
    return url.includes('/images/')
      ? Response.json({ images: { '1:1': 'https://cdn.example.com/home.svg' } })
      : new Response(svg)
  })
  vi.stubGlobal('fetch', request)
  const source = {
    type: 'figma' as const,
    file: 'AbCdEfGhIjKlMnOpQrStUv',
    depth: 3,
    token: 'pat',
    pages: ['Icons'],
    iconNameForNode: (node: { name: string }) =>
      node.name === 'home' ? 'custom-home' : null,
  }
  const options = {
    cwd: directory,
    prefix: 'brand',
    cacheDir: '.cache',
    skipPrefix: [],
    env: {},
  }
  const first = await loadFigmaSource(source, options)
  expect(first.iconSet?.list()).toEqual(['custom-home'])
  const second = await loadFigmaSource(source, options)
  expect(second.iconSet?.list()).toEqual(['custom-home'])
  expect(request).toHaveBeenCalledTimes(3)
})

it('batches large image exports while retaining the file version', async () => {
  const data = document()
  data.document.children[0]!.children = Array.from({ length: 400 }, (_, i) =>
    component(`1:${i}`, `icon-${i}`))
  let batches = 0
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname.includes('/files/')) {
      return Response.json(data)
    }
    if (url.pathname.includes('/images/')) {
      batches++
      expect(url.href.length).toBeLessThan(2048)
      expect(url.searchParams.get('version')).toBe('v1')
      return Response.json({
        images: Object.fromEntries(
          url.searchParams
            .get('ids')!
            .split(',')
            .map(id => [id, 'https://cdn.example.com/shared.svg']),
        ),
      })
    }
    return new Response(svg)
  })
  const result = await loadFigmaSource(
    {
      type: 'figma',
      file: 'AbCdEfGhIjKlMnOpQrStUv',
      depth: 3,
      pages: ['Icons'],
      token: 'pat',
    },
    {
      cwd: directory,
      prefix: 'brand',
      cacheDir: '.cache',
      skipPrefix: [],
      env: {},
    },
  )
  expect(result.iconSet?.list()).toHaveLength(400)
  expect(batches).toBeGreaterThan(1)
})

it('uses an injected provider with source indices and preserves unchanged sources on multi-source sync', async () => {
  let revision = 1
  const request = vi.fn(async (input: string | URL, init: RequestInit) => {
    const url = new URL(input)
    if (url.hostname === 'cdn.example.com') {
      expect(init.headers).toBeUndefined()
      return new Response(svg)
    }
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer broker-access',
    )
    if (url.pathname.includes('/files/')) {
      const data = document()
      const second = url.pathname.endsWith('ZbCdEfGhIjKlMnOpQrStUv')
      data.document.children = [data.document.children[0]!]
      data.document.children[0]!.children = [
        component('1:1', second ? `second-${revision}` : 'first'),
      ]
      data.version = second ? `v${revision}` : 'v1'
      return Response.json(data)
    }
    return Response.json({
      images: {
        '1:1': `https://cdn.example.com/${url.pathname.split('/').pop()}-${revision}.svg`,
      },
    })
  })
  vi.stubGlobal('fetch', request)
  const provider = vi.fn(async (_source: unknown, sourceIndex?: number) => {
    expect(sourceIndex).toBeTypeOf('number')
    return {
      kind: 'oauth' as const,
      cacheIdentity: 'broker',
      token: async () => 'broker-access',
    }
  })
  const config = resolveConfig({
    prefix: 'brand',
    sources: [
      { type: 'figma', file: 'AbCdEfGhIjKlMnOpQrStUv' },
      { type: 'figma', file: 'ZbCdEfGhIjKlMnOpQrStUv' },
    ],
  })
  const first = await sync({
    cwd: directory,
    config,
    env: {},
    figmaAuthProvider: provider,
  })
  expect(Object.keys(first.json.icons).sort()).toEqual(['first', 'second-1'])
  revision++
  const second = await sync({
    cwd: directory,
    config,
    env: {},
    figmaAuthProvider: provider,
  })
  expect(Object.keys(second.json.icons).sort()).toEqual(['first', 'second-2'])
  expect(second.diff.removed).toEqual(['second-1'])
  expect(second.diff.added).toEqual(['second-2'])
  expect(provider.mock.calls.map(call => call[1])).toEqual([0, 1, 0, 1])
})

it('does not mark validation failures cached and revalidates after a configuration change', async () => {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname.includes('/files/')) {
      return Response.json(document())
    }
    if (url.pathname.includes('/images/')) {
      return Response.json({
        images: { '1:1': 'https://cdn.example.com/home.svg' },
      })
    }
    return new Response(svg)
  })
  const input = {
    prefix: 'brand',
    sources: [
      {
        type: 'figma' as const,
        file: 'AbCdEfGhIjKlMnOpQrStUv',
        token: 'pat',
        pages: ['Icons'],
      },
    ],
  }
  await expect(
    sync({
      cwd: directory,
      config: resolveConfig({ ...input, validate: { width: 16 } }),
    }),
  ).rejects.toThrow(/validation/)
  await expect(
    readFile(join(directory, '.iconctl-cache/meta.json')),
  ).rejects.toThrow()
  await sync({ cwd: directory, config: resolveConfig(input) })
  await expect(
    sync({
      cwd: directory,
      config: resolveConfig({ ...input, validate: { width: 16 } }),
    }),
  ).rejects.toThrow(/validation/)
})
