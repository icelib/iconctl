import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig, sync } from '../src'
import { mergeChangelog } from '../src/changelog'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#111111" d="M0 0h24v24H0z"/></svg>`

describe('changelog', () => {
  it('returns undefined when the set did not change', () => {
    expect(mergeChangelog('# Changelog\n', {
      added: [],
      removed: [],
      changed: [],
      unchanged: ['arrow-left'],
    })).toBeUndefined()
  })

  it('prepends a dated section', () => {
    const next = mergeChangelog('# Changelog\n', {
      added: ['bell'],
      removed: [],
      changed: ['arrow-left'],
      unchanged: [],
    }, '2026-09-18')
    expect(next).toContain('## 2026-09-18')
    expect(next).toContain('- Added: `bell`')
    expect(next).toContain('- Changed: `arrow-left`')
  })

  it('merges into the same date heading', () => {
    const existing = `# Changelog

## 2026-09-18

- Added: \`star\`
`
    const next = mergeChangelog(existing, {
      added: ['bell'],
      removed: [],
      changed: [],
      unchanged: [],
    }, '2026-09-18')
    expect(next).toContain('- Added: `bell`')
    expect(next).toContain('- Added: `star`')
    expect(next?.match(/## 2026-09-18/g)?.length).toBe(1)
  })

  it('writes CHANGELOG.md during sync', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'iconctl-cl-'))
    const raw = path.join(dir, 'raw')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(raw, { recursive: true })
    await writeFile(path.join(raw, 'arrow-left.svg'), svg, 'utf8')

    await sync({
      cwd: dir,
      config: resolveConfig({
        prefix: 'brand',
        sources: [{ type: 'directory', dir: raw }],
        output: { json: 'icons.json', changelog: 'CHANGELOG.md' },
      }),
    })

    const first = await readFile(path.join(dir, 'CHANGELOG.md'), 'utf8')
    expect(first).toContain('- Added: `arrow-left`')

    await writeFile(path.join(raw, 'user.svg'), svg, 'utf8')
    await sync({
      cwd: dir,
      config: resolveConfig({
        prefix: 'brand',
        sources: [{ type: 'directory', dir: raw }],
        output: { json: 'icons.json', changelog: 'CHANGELOG.md' },
      }),
    })

    const second = await readFile(path.join(dir, 'CHANGELOG.md'), 'utf8')
    expect(second).toContain('- Added: `user`')
    expect(second).toContain('arrow-left')
  })
})
