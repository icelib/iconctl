import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveConfig, sync } from '@iconctl/core'
import { expect, it } from 'vitest'
import { svgByteLength } from '../../../packages/figma-plugin/src/svg-handoff-format'
import { createHandoffZip } from '../../../packages/figma-plugin/src/svg-handoff-zip'
import { extractSvgArchive, validateDirectory } from '../src/files'

const exec = promisify(execFile)

it('consumes a plugin ZIP with independent unzip, runner extraction and current-built core directory sync', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'iconctl-handoff-'))
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16" viewBox="0 0 32 16"><defs><linearGradient id="g"><stop stop-color="#123456"/></linearGradient><mask id="m"><path fill="white" d="M0 0h32v16H0z"/></mask></defs><path d="M4 4h8v8H4z" fill="url(#g)" mask="url(#m)"/><title>中文🙂</title></svg>'
    const files = ['arrow-left', 'actions-filled'].map(name => ({ path: `raw-svg/${name}.svg`, svg, bytes: svgByteLength(svg) }))
    const zip = createHandoffZip(files)
    const archive = join(cwd, 'handoff.zip')
    await writeFile(archive, zip)
    // System unzip provides a reader independent of the plugin/runner's fflate.
    const listing = await exec('unzip', ['-Z1', archive])
    expect(listing.stdout.trim().split('\n')).toEqual(['raw-svg/actions-filled.svg', 'raw-svg/arrow-left.svg'])
    expect((await exec('unzip', ['-p', archive, 'raw-svg/arrow-left.svg'])).stdout).toBe(svg)
    await extractSvgArchive(zip, join(cwd, 'input'))
    const directory = await validateDirectory(join(cwd, 'input'), 'raw-svg')
    expect(await readFile(join(directory, 'arrow-left.svg'), 'utf8')).toBe(svg)
    const config = resolveConfig({
      prefix: 'handoff',
      sources: [{ type: 'directory', dir: directory }],
      validate: { width: 32, height: 16 },
      output: { json: 'icons.json', svg: 'svg', types: 'icons.d.ts', preview: 'preview.html' },
    })
    const before = (await readdir(cwd)).sort()
    const dry = await sync({ cwd, config, dryRun: true })
    expect(dry.diff.added.sort()).toEqual(['actions-filled', 'arrow-left'])
    expect(dry.failed).toEqual([])
    expect((await readdir(cwd)).sort()).toEqual(before)
    const result = await sync({ cwd, config })
    expect(result.failed).toEqual([])
    const json = JSON.parse(await readFile(join(cwd, 'icons.json'), 'utf8'))
    expect(Object.keys(json.icons).sort()).toEqual(['actions-filled', 'arrow-left'])
    expect(json.icons['arrow-left'].width ?? json.width ?? 16).toBe(32)
    expect(json.icons['arrow-left'].height ?? json.height ?? 16).toBe(16)
    expect(await readFile(join(cwd, 'svg/arrow-left.svg'), 'utf8')).toContain('<svg')
    expect(await readFile(join(cwd, 'icons.d.ts'), 'utf8')).toContain('arrow-left')
    expect(await readFile(join(cwd, 'preview.html'), 'utf8')).toContain('handoff:arrow-left')
  }
  finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
