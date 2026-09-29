import process from 'node:process'
import { loadConfig, resolveConfig, sync } from '@iconctl/core'
import { consola } from 'consola'
import { runCli } from '../src/program'

vi.mock('@iconctl/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@iconctl/core')>()
  return { ...actual, loadConfig: vi.fn(), sync: vi.fn() }
})
beforeEach(() => {
  vi.mocked(loadConfig).mockResolvedValue(resolveConfig({ prefix: 'fixture', sources: [{ type: 'directory', dir: 'svg' }] }))
  vi.mocked(sync).mockResolvedValue({
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
  })
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
