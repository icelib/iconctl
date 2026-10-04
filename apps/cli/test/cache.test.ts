import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { runCli } from '../src/program'

const url = 'https://cdn.example.test/icons.json'
const body = JSON.stringify({ prefix: 'vendor', icons: { home: { body: '<path/>' } } })

describe('cache diagnose CLI', () => {
  let cwd: string
  let previous: string
  let output: string
  const cacheFile = (target = url, cacheDir = '.cache') => path.join(cwd, cacheDir, 'iconify-v1', `${createHash('sha256').update(target).digest('hex')}.json`)
  const diagnose = (...args: string[]) => runCli(['node', 'iconctl', 'cache', 'diagnose', ...args])
  const report = () => JSON.parse(output)

  async function stored(contents: string | Uint8Array, target = url) {
    const file = cacheFile(target)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, contents)
    return file
  }

  async function executableConfig() {
    const marker = path.join(cwd, 'config-executed')
    await writeFile(path.join(cwd, 'iconctl.config.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('Config must not execute');`)
    return marker
  }

  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iconctl-cache-cli-')))
    previous = process.cwd()
    process.chdir(cwd)
    process.exitCode = 0
    output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      output += String(text)
      return true
    })
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('Cache diagnosis must not fetch')
    }))
    await writeFile(path.join(cwd, 'iconctl.config.mjs'), `export default ${JSON.stringify({ prefix: 'brand', sources: [{ type: 'directory', dir: 'raw' }], cacheDir: '.cache' })}`)
  })
  afterEach(async () => {
    const requests = vi.mocked(fetch).mock.calls.length
    process.chdir(previous)
    process.exitCode = 0
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await rm(cwd, { recursive: true, force: true })
    expect(requests).toBe(0)
  })

  it('loads the configured cache directory without creating it or icon outputs', async () => {
    await diagnose('--json')
    expect(report()).toEqual({ directory: path.join(cwd, '.cache', 'iconify-v1'), entries: [], valid: 0, invalid: 0, missing: 0 })
    expect(await readdir(cwd)).toEqual(['iconctl.config.mjs'])
  })

  it('inspects a valid URL key without changing cache bytes or exposing its body', async () => {
    const contents = JSON.stringify({ url, body, etag: '"v1"', lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' })
    const file = await stored(contents)
    const other = await stored('{', 'https://cdn.example.test/other.json')
    const before = await readdir(cwd, { recursive: true })
    await diagnose('--url', url, '--strict', '--json')
    expect(report()).toMatchObject({ url, valid: 1, invalid: 0, missing: 0, entries: [{ file, status: 'valid', etag: '"v1"' }] })
    expect(report().entries).toHaveLength(1)
    expect(report().entries[0]).not.toHaveProperty('body')
    expect(process.exitCode).toBe(0)
    expect(await readFile(file, 'utf8')).toBe(contents)
    expect(await readFile(other, 'utf8')).toBe('{')
    expect(await readdir(cwd, { recursive: true })).toEqual(before)
  })

  it.each([
    ['malformed JSON', '{'],
    ['malformed UTF-8', Buffer.from([0xFF])],
    ['missing metadata URL', JSON.stringify({ body })],
    ['different metadata URL', JSON.stringify({ url: 'https://cdn.example.test/other.json', body })],
  ])('retains a selected cache with %s in the strict report', async (_label, contents) => {
    const file = await stored(contents)
    await diagnose('--url', url, '--strict', '--json')
    expect(report()).toMatchObject({ url, valid: 0, invalid: 1, missing: 0, entries: [{ file, status: 'invalid', error: expect.any(String) }] })
    expect(report().entries).toHaveLength(1)
    expect(process.exitCode).toBe(1)
    expect(await readFile(file)).toEqual(Buffer.from(contents))
  })

  it('reports a directory at the selected cache key as invalid without changing it', async () => {
    const file = cacheFile()
    await mkdir(file, { recursive: true })
    await writeFile(path.join(file, 'keep'), 'user content')
    await diagnose('--url', url, '--strict', '--json')
    expect(report()).toMatchObject({ valid: 0, invalid: 1, missing: 0, entries: [{ file, status: 'invalid' }] })
    expect(process.exitCode).toBe(1)
    expect(await readFile(path.join(file, 'keep'), 'utf8')).toBe('user content')
  })

  it.each([false, true])('reports the exact missing URL key (strict: %s)', async (strict) => {
    await diagnose('--url', url, ...(strict ? ['--strict'] : []), '--json')
    expect(report()).toEqual({
      directory: path.join(cwd, '.cache', 'iconify-v1'),
      url,
      entries: [{ file: cacheFile(), status: 'missing', bytes: 0, error: 'Cache entry is missing' }],
      valid: 0,
      invalid: 0,
      missing: 1,
    })
    expect(process.exitCode).toBe(strict ? 1 : 0)
    expect(await readdir(cwd)).toEqual(['iconctl.config.mjs'])
  })

  it('includes all invalid entries in strict scans without a URL filter', async () => {
    const file = await stored('{')
    await diagnose('--strict', '--json')
    expect(report()).toMatchObject({ valid: 0, invalid: 1, missing: 0, entries: [{ file, status: 'invalid' }] })
    expect(process.exitCode).toBe(1)
  })

  it('prints missing entries distinctly in human-readable output', async () => {
    await diagnose('--url', url)
    expect(output).toContain('Valid 0 · Invalid 0 · Missing 1')
    expect(output).toContain(`missing ${cacheFile()}: Cache entry is missing`)
  })

  it('uses an explicit cache directory with no configuration file', async () => {
    await rm(path.join(cwd, 'iconctl.config.mjs'))
    await diagnose('--cache-dir', 'detached-cache', '--json')
    expect(report()).toEqual({ directory: path.join(cwd, 'detached-cache', 'iconify-v1'), entries: [], valid: 0, invalid: 0, missing: 0 })
    expect(await readdir(cwd)).toEqual([])
  })

  it('does not execute an existing configuration with an explicit cache directory', async () => {
    const marker = await executableConfig()
    const file = await stored(JSON.stringify({ url, body }))
    await diagnose('--cache-dir', '.cache', '--url', url, '--strict', '--json')
    expect(report()).toMatchObject({ valid: 1, invalid: 0, missing: 0, entries: [{ file, status: 'valid' }] })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['--url', ''],
    ['--url', '   '],
    ['--url', 'not-a-url'],
    ['--url', 'http://cdn.example.test/icons.json'],
    ['--url', 'https://user:secret@cdn.example.test/icons.json'],
    ['--url', url, '--url', url],
    ['--cache-dir', ''],
    ['--cache-dir', 'https://cdn.example.test/cache'],
    ['--cache-dir', '.cache', '--cache-dir', '.cache'],
    ['--config', 'iconctl.config.mjs', '--cache-dir', '.cache'],
    ['--config', ''],
  ])('rejects invalid arguments before loading config: %j', async (...args) => {
    const marker = await executableConfig()
    await expect(diagnose(...args, '--json')).rejects.toThrow()
    expect(report()).toMatchObject({ success: false, command: 'cache', error: { phase: 'arguments' } })
    expect(process.exitCode).toBe(1)
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(cwd)).toEqual(['iconctl.config.mjs'])
  })

  it('rejects unknown operations as arguments without loading config', async () => {
    const marker = await executableConfig()
    await expect(runCli(['node', 'iconctl', 'cache', 'clear', '--json'])).rejects.toThrow('cache diagnose')
    expect(report()).toMatchObject({ success: false, command: 'cache', error: { phase: 'arguments' } })
    expect(process.exitCode).toBe(1)
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
