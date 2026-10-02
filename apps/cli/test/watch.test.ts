import type { SyncResult } from '@iconctl/core'
import process from 'node:process'
import { IconctlAbortError, IconctlSyncError, watch } from '@iconctl/core'
import { runCli } from '../src/program'
import { printWatchEvent } from '../src/watch'

vi.mock('@iconctl/core', async (original) => {
  const actual = await original<typeof import('@iconctl/core')>()
  return { ...actual, watch: vi.fn() }
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = 0
})

it('serializes compact NDJSON summaries and only safe error fields', () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const result: SyncResult = {
    prefix: 'demo',
    complete: true,
    notModified: false,
    processed: 1,
    failed: [],
    issues: [],
    sources: [],
    diff: { added: ['home'], removed: [], changed: [], unchanged: [], deletionsReliable: true },
    files: ['icons.json'],
    json: { prefix: 'demo', icons: { home: { body: '<secret-svg/>' } } },
  }
  printWatchEvent({ type: 'ready', configFile: 'iconctl.config.ts', roots: ['raw'] }, true)
  printWatchEvent({ type: 'start', runId: 1, reason: 'initial' }, true)
  printWatchEvent({ type: 'result', runId: 1, result }, true)
  printWatchEvent({ type: 'error', phase: 'sync', fatal: false, error: new IconctlSyncError([{ name: 'bad', message: 'invalid SVG', stage: 'import' }]) }, true)
  printWatchEvent({ type: 'stopped', reason: 'aborted' }, true)
  const lines = write.mock.calls.map(call => String(call[0]))
  expect(lines.every(line => line.split('\n').length === 2)).toBe(true)
  expect(lines.map(line => JSON.parse(line).type)).toEqual(['ready', 'start', 'result', 'error', 'stopped'])
  expect(JSON.parse(lines[2]!)).toMatchObject({ result: { complete: true, added: ['home'], outputFiles: ['icons.json'] } })
  expect(JSON.parse(lines[3]!).error).toEqual({ name: 'IconctlSyncError', message: expect.any(String), issues: [{ name: 'bad', message: 'invalid SVG', stage: 'import' }] })
  expect(lines.join('')).not.toContain('secret-svg')
})

it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('drains %s cancellation and removes signal listeners', async (signal, code) => {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const before = process.listenerCount(signal)
  let drained = false
  vi.mocked(watch).mockImplementationOnce(async (options) => {
    options.onEvent({ type: 'ready', configFile: 'fixture.ts', roots: ['raw'] })
    process.emit(signal)
    expect(options.signal!.aborted).toBe(true)
    await Promise.resolve()
    drained = true
    options.onEvent({ type: 'stopped', reason: 'aborted' })
    throw new IconctlAbortError(options.signal!.reason)
  })
  await runCli(['node', 'iconctl', 'watch', '--config', 'fixture.ts', '--dry-run', '--continue', '--json'])
  expect(drained).toBe(true)
  expect(process.exitCode).toBe(code)
  expect(process.listenerCount(signal)).toBe(before)
  expect(watch).toHaveBeenLastCalledWith(expect.objectContaining({ configFile: 'fixture.ts', dryRun: true, continueOnError: true }))
})

it('keeps recoverable errors running and exits one for fatal errors', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  process.exitCode = 0
  vi.mocked(watch).mockImplementationOnce(async (options) => {
    options.onEvent({ type: 'error', phase: 'sync', fatal: false, error: new Error('bad SVG') })
    expect(process.exitCode).toBe(0)
    options.onEvent({ type: 'error', phase: 'watch', fatal: true, error: new Error('watch unavailable') })
    throw new Error('watch unavailable')
  })
  await runCli(['node', 'iconctl', 'watch'])
  expect(process.exitCode).toBe(1)
  expect(stderr.mock.calls.map(call => String(call[0]))).toEqual(['Recoverable sync error: bad SVG\n', 'Fatal watch error: watch unavailable\n'])
})
