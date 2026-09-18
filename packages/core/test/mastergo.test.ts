import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseMastergoRef, resolveConfig, resolveMastergoToken, sync } from '../src'
import { IconctlError } from '../src/errors'

describe('mastergo', () => {
  it('parses file URLs', () => {
    expect(parseMastergoRef({
      file: 'https://mastergo.com/file/192644601973042?layer_id=40:015',
    })).toEqual({ fileId: '192644601973042', layerId: '40:015' })
  })

  it('reads MASTERGO_TOKEN', () => {
    expect(resolveMastergoToken(undefined, { MASTERGO_TOKEN: 'mg_test' })).toBe('mg_test')
    expect(resolveMastergoToken(undefined, { MG_MCP_TOKEN: 'mg_mcp' })).toBe('mg_mcp')
    expect(() => resolveMastergoToken(undefined, {})).toThrow(IconctlError)
  })

  it('loads paginated extract-svg responses', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      expect(url).toContain('/mcp/extract-svg')
      return new Response(JSON.stringify({
        totalCount: 1,
        count: 1,
        hasMore: false,
        svgs: [
          {
            id: '1:2',
            name: 'home',
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000" d="M3 10l9-7 9 7v10H3z"/></svg>',
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'iconctl-mg-'))
      const config = resolveConfig({
        prefix: 'brand',
        sources: [{
          type: 'mastergo',
          file: 'https://mastergo.com/file/192644601973042?layer_id=40:015',
          token: 'mg_test',
        }],
        output: { json: 'icons.json' },
      })
      const result = await sync({ cwd, config })
      expect(result.sources[0]?.type).toBe('mastergo')
      expect(result.diff.added).toEqual(['home'])
      const json = JSON.parse(await readFile(path.join(cwd, 'icons.json'), 'utf8')) as { icons: Record<string, { body: string }> }
      expect(json.icons['home']?.body).toContain('currentColor')
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })
})
