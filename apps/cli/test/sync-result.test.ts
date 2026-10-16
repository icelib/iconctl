import type { SyncResult } from '@iconctl/core'
import process from 'node:process'
import { loadConfig, resolveConfig, sync } from '@iconctl/core'
import { consola } from 'consola'
import { runCli } from '../src/program'

vi.mock('@iconctl/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@iconctl/core')>()
  return { ...actual, loadConfig: vi.fn(), sync: vi.fn() }
})

function syncResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    prefix: 'fixture',
    complete: false,
    notModified: false,
    processed: 1,
    failed: ['bad'],
    issues: [{ name: 'bad', nodeId: '1:2', stage: 'download', message: 'HTTP 503' }],
    sources: [{ type: 'figma', notModified: false }],
    diff: { added: ['good'], removed: [], changed: [], unchanged: [], deletionsReliable: false },
    files: ['icons.json'],
    json: { prefix: 'fixture', icons: { good: { body: '<path/>' } } },
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(loadConfig).mockResolvedValue(resolveConfig({ prefix: 'fixture', sources: [{ type: 'directory', dir: 'svg' }] }))
  vi.mocked(sync).mockResolvedValue(syncResult())
})
afterEach(() => vi.restoreAllMocks())

it('prints machine-readable incomplete results without claiming deletions', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  await runCli(['node', 'iconctl', 'sync', '--continue', '--json'])
  const result = JSON.parse(String(write.mock.calls[0]![0]))
  expect(result).toMatchObject({ complete: false, deletionsReliable: false, removed: [], skipped: ['bad'], issues: [{ nodeId: '1:2', stage: 'download' }] })
  expect(sync).toHaveBeenCalledWith(expect.objectContaining({ continueOnError: true }))
})

it('warns about incomplete syncs and includes the failed node in plain output', async () => {
  const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {})
  const success = vi.spyOn(consola, 'success').mockImplementation(() => {})
  vi.spyOn(consola, 'info').mockImplementation(() => {})
  await runCli(['node', 'iconctl', 'sync', '--continue'])
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('Incomplete sync'))
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad (1:2) [download]'))
  expect(success).not.toHaveBeenCalled()
})

it('forwards offline mode to config-backed syncs', async () => {
  await runCli(['node', 'iconctl', 'sync', '--offline'])
  expect(sync).toHaveBeenCalledWith(expect.objectContaining({ offline: true }))
})

it('keeps naming optional in JSON and includes available dry-run plans', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  await runCli(['node', 'iconctl', 'sync', '--json'])
  expect(JSON.parse(String(write.mock.calls[0]![0]))).not.toHaveProperty('naming')
  vi.mocked(sync).mockResolvedValue(syncResult({ naming: [] }))
  await runCli(['node', 'iconctl', 'sync', '--dry-run', '--json'])
  expect(JSON.parse(String(write.mock.calls[1]![0])).naming).toEqual([])
  expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: true }))
})

it('prints grouped naming warnings on otherwise complete syncs', async () => {
  const message = 'Duplicate icon name "bell" was disambiguated.'
  vi.mocked(sync).mockResolvedValue(syncResult({
    complete: true,
    failed: [],
    issues: ['1:2', '1:3'].map(nodeId => ({ name: 'bell', nodeId, stage: 'import', message, collisionGroup: 'bell', severity: 'warning', proposedName: `bell-${nodeId.replace(':', '-')}` })),
  }))
  const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {})
  const success = vi.spyOn(consola, 'success').mockImplementation(() => {})
  vi.spyOn(consola, 'info').mockImplementation(() => {})
  await runCli(['node', 'iconctl', 'sync'])
  expect(success).toHaveBeenCalledWith('Synced 1 icons for prefix "fixture"')
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(message))
  const formatted = String(warn.mock.calls[0]![0])
  expect(formatted.split(message)).toHaveLength(2)
  expect(formatted).toContain('node: 1:2')
  expect(formatted).toContain('node: 1:3')
  expect(formatted).toContain('proposed: "bell-1-3"')
})
