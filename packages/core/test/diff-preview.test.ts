import { Buffer } from 'node:buffer'
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareIconSets } from '../src/diff'
import { renderDiffHtml, writeDiffHtml } from '../src/diff-preview'
import { OutputTransaction } from '../src/output-transaction'
import { renderPreviewHtml } from '../src/preview'

const comparison = compareIconSets(
  { prefix: 'before', icons: { arrow: { body: '<path d="M1 2h8v4H1z"/>' } } },
  { prefix: 'after', icons: { arrow: { body: '<path d="M0 0h4v4z"/>' } } },
)

describe('offline HTML', () => {
  it('escapes names and prefixes while isolating untrusted SVG inside image documents', () => {
    const marker = '<script>globalThis.reportInjected=true</script>'
    const json = { prefix: `brand"${marker}`, icons: { [`x"${marker}`]: { body: `${marker}<foreignObject><div>unsafe</div></foreignObject><path/>` } } }
    for (const html of [renderDiffHtml(compareIconSets(undefined, json)), renderPreviewHtml(json)]) {
      expect(html).not.toContain(marker)
      expect(html).toContain('&lt;script&gt;')
      expect(html).not.toContain('<foreignObject>')
      expect(html).toContain('Content-Security-Policy')
      expect(html).toContain('default-src &#39;none&#39;')
      expect(html).toContain('img-src data:')
      expect(html).toContain('sha256-')
      const image = html.match(/src="data:image\/svg\+xml;base64,([^"]+)"/)?.[1]
      expect(image).toBeDefined()
      expect(Buffer.from(image!, 'base64').toString()).toContain(marker)
    }
  })

  it('renders aliases with resolved geometry in the ordinary preview too', () => {
    const html = renderPreviewHtml({ prefix: 'brand', width: 24, height: 16, icons: { arrow: { body: '<path/>' } }, aliases: { rotated: { parent: 'arrow', rotate: 1 } } })
    expect(html).toContain('brand:rotated')
    const images = [...html.matchAll(/src="data:image\/svg\+xml;base64,([^"]+)"/g)].map(match => Buffer.from(match[1]!, 'base64').toString())
    expect(images).toHaveLength(2)
    expect(images[1]).toContain('viewBox="0 0 16 24"')
    expect(images[1]).toContain('rotate(90')
  })
})

describe('writeDiffHtml', () => {
  let cwd: string
  let input: string
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'iconctl-report-'))
    input = join(cwd, 'icons.json')
    await writeFile(input, '{"input":true}')
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(cwd, { recursive: true, force: true })
  })

  it('creates nested destinations and atomically replaces existing reports without leaving staging files', async () => {
    const output = join(cwd, 'reports', 'diff.html')
    await writeDiffHtml(output, comparison, { inputs: [input] })
    expect(await readFile(output, 'utf8')).toContain('Prefix changed')
    await writeFile(output, 'previous')
    await writeDiffHtml(output, comparison)
    expect(await readFile(output, 'utf8')).toContain('Icon changes')
    expect(await readdir(cwd)).toEqual(['icons.json', 'reports'])
    expect(await readdir(join(cwd, 'reports'))).toEqual(['diff.html'])
  })

  it('validates dry-run destinations without creating directories or staging files', async () => {
    await writeDiffHtml(join(cwd, 'new', 'diff.html'), comparison, { inputs: [input], dryRun: true })
    expect(await readdir(cwd)).toEqual(['icons.json'])
  })

  it('rejects direct, hard-link and directory-alias input conflicts even in dry-run', async () => {
    const hardlink = join(cwd, 'hardlink.html')
    const alias = join(cwd, 'alias')
    await link(input, hardlink)
    await symlink(cwd, alias)
    for (const target of [input, hardlink, join(alias, 'icons.json')]) {
      await expect(writeDiffHtml(target, comparison, { inputs: [input], dryRun: true })).rejects.toThrow(/conflicts with input/)
    }
    expect(await readFile(input, 'utf8')).toBe('{"input":true}')
  })

  it('rejects symlink and directory destinations', async () => {
    const symlinkTarget = join(cwd, 'report.html')
    const directory = join(cwd, 'directory')
    await symlink(input, symlinkTarget)
    await mkdir(directory)
    for (const target of [symlinkTarget, directory]) {
      await expect(writeDiffHtml(target, comparison)).rejects.toThrow(/regular file/)
    }
  })

  it('preserves the previous report and disposes staging files when writing fails before commit', async () => {
    const output = join(cwd, 'report.html')
    await writeFile(output, 'previous report')
    vi.spyOn(OutputTransaction.prototype, 'commit').mockRejectedValueOnce(new Error('disk failure'))
    await expect(writeDiffHtml(output, comparison)).rejects.toThrow('disk failure')
    expect(await readFile(output, 'utf8')).toBe('previous report')
    expect(await readdir(cwd)).toEqual(['icons.json', 'report.html'])
  })
})
