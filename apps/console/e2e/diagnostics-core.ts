import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, sync } from '@iconctl/core'

export const firstFile = 'AbCdEfGhIjKlMnOpQrStUv'
export const winningFile = 'ZbCdEfGhIjKlMnOpQrStUv'
export const winningNode = '8:9'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'

export async function generateCoreResult() {
  const cwd = await mkdtemp(join(tmpdir(), 'iconctl-browser-provenance-'))
  const originalFetch = globalThis.fetch
  const files: Record<string, { id: string, name: string }[]> = {
    [firstFile]: [{ id: '1:1', name: 'shared' }, { id: '1:2', name: 'missing-export' }],
    [winningFile]: [{ id: winningNode, name: 'shared' }],
  }
  try {
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (request.method !== 'GET') {
        throw new Error(`Unexpected core fixture request: ${request.method} ${url}`)
      }
      if (url.origin === 'https://cdn.example.com') {
        const [file, node] = url.pathname.slice(1).split('/')
        if (!files[file!]?.some(icon => icon.id === node)) {
          throw new Error(`Unexpected SVG fixture: ${url}`)
        }
        return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
      }
      if (url.origin !== 'https://api.figma.com') {
        throw new Error(`Unexpected core fixture origin: ${url.origin}`)
      }
      const [version, resource, file] = url.pathname.slice(1).split('/')
      const icons = files[file!]
      if (version !== 'v1' || !icons) {
        throw new Error(`Unexpected Figma fixture: ${url}`)
      }
      if (resource === 'files') {
        return Response.json({
          editorType: 'figma',
          version: '1',
          lastModified: '1',
          document: { id: '0:0', type: 'DOCUMENT', children: [{
            id: '0:1',
            name: 'Icons',
            type: 'CANVAS',
            children: icons.map(({ id, name }) => ({
              id,
              name,
              type: 'COMPONENT',
              children: [],
              absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
            })),
          }] },
        })
      }
      if (resource === 'images') {
        return Response.json({ images: Object.fromEntries(icons.filter(icon => icon.id !== '1:2').map(icon => [icon.id, `https://cdn.example.com/${file}/${icon.id}`])) })
      }
      throw new Error(`Unexpected Figma fixture resource: ${url}`)
    }
    return await sync({
      cwd,
      config: resolveConfig({
        prefix: 'brand',
        sources: [firstFile, winningFile].map(file => ({ type: 'figma', file, token: 'fixture', pages: ['Icons'] })),
        validate: { height: 16, name: /^allowed$/ },
      }),
      continueOnError: true,
      dryRun: true,
    })
  }
  finally {
    globalThis.fetch = originalFetch
    await rm(cwd, { recursive: true, force: true })
  }
}
