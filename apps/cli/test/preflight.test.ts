import process from 'node:process'
import { loadConfig, preflightFigmaNaming, resolveConfig } from '@iconctl/core'
import { consola } from 'consola'
import { runCli } from '../src/program'

vi.mock('@iconctl/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@iconctl/core')>()
  return { ...actual, loadConfig: vi.fn(), preflightFigmaNaming: vi.fn() }
})

function namingPlan() {
  return {
    sourceIndex: 0,
    fileKey: 'design',
    namespace: '',
    fileVersion: 'v1',
    lastModified: '2026-10-16',
    policy: 'suffix-node-id' as const,
    mappings: [{ nodeId: '1:2', originalName: 'Bell', baseName: 'bell', parentPath: ['Icons'], figmaUrl: 'https://www.figma.com/design/design?node-id=1-2', name: 'bell' }],
    changes: {
      added: ['bell'],
      removed: [],
      renamed: [],
      disambiguated: [{ nodeId: '1:3', from: 'bell', to: 'bell-1-3' }],
    },
  }
}

describe('Figma naming preflight command', () => {
  let output: string
  beforeEach(() => {
    process.exitCode = 0
    output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      output += String(text)
      return true
    })
    vi.spyOn(consola, 'warn').mockImplementation(() => {})
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    vi.spyOn(consola, 'success').mockImplementation(() => {})
    vi.spyOn(consola, 'info').mockImplementation(() => {})
    vi.mocked(loadConfig).mockResolvedValue(resolveConfig({ prefix: 'fixture', sources: [{ type: 'figma', file: 'design', naming: { duplicates: 'suffix-node-id' } }] }))
    vi.mocked(preflightFigmaNaming).mockResolvedValue({
      complete: true,
      naming: [namingPlan()],
      issues: [],
      publicNames: { added: ['bell'], removed: [], deletionsReliable: true },
      files: [],
    })
  })
  afterEach(() => {
    process.exitCode = 0
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  it('prints the naming plan and public-name changes as one JSON result', async () => {
    await runCli(['node', 'iconctl', 'preflight', '--config', 'custom.config.ts', '--json'])
    expect(JSON.parse(output)).toEqual({
      complete: true,
      naming: [namingPlan()],
      issues: [],
      publicNames: { added: ['bell'], removed: [], deletionsReliable: true },
      outputFiles: [],
    })
    expect(loadConfig).toHaveBeenCalledWith({ cwd: process.cwd(), configFile: 'custom.config.ts' })
    expect(preflightFigmaNaming).toHaveBeenCalledWith({ cwd: process.cwd(), config: await vi.mocked(loadConfig).mock.results[0]!.value })
    expect(consola.warn).not.toHaveBeenCalled()
    expect(consola.error).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(0)
  })

  it('returns an incomplete JSON report and exits nonzero without a second error envelope', async () => {
    vi.mocked(preflightFigmaNaming).mockResolvedValue({
      complete: false,
      naming: [namingPlan()],
      issues: [{ name: 'bell', message: 'Duplicate icon name', stage: 'import', code: 'FIGMA_DUPLICATE_NAME', severity: 'error' }],
      publicNames: { added: [], removed: [], deletionsReliable: false },
      files: [],
    })
    await expect(runCli(['node', 'iconctl', 'preflight', '--json'])).resolves.toBeUndefined()
    expect(JSON.parse(output)).toMatchObject({ complete: false, issues: [{ code: 'FIGMA_DUPLICATE_NAME', severity: 'error' }], outputFiles: [] })
    expect(process.exitCode).toBe(1)
    expect(consola.error).not.toHaveBeenCalled()
  })

  it('prints node counts, changes, grouped warnings and uncertain mixed-source deletions', async () => {
    const message = 'Duplicate icon name "bell" was disambiguated.'
    vi.mocked(preflightFigmaNaming).mockResolvedValue({
      complete: true,
      naming: [namingPlan()],
      issues: ['1:2', '1:3'].map(nodeId => ({
        name: 'bell',
        originalName: 'Bell',
        nodeId,
        parentPath: ['Icons'],
        proposedName: `bell-${nodeId.replace(':', '-')}`,
        figmaUrl: `https://www.figma.com/design/design?node-id=${nodeId.replace(':', '-')}`,
        collisionGroup: 'bell',
        severity: 'warning' as const,
        stage: 'import' as const,
        message,
      })),
      publicNames: { added: ['bell'], removed: [], deletionsReliable: false },
      files: [],
    })
    await runCli(['node', 'iconctl', 'preflight'])
    expect(consola.success).toHaveBeenCalledWith('Checked 1 Figma icon nodes in 1 sources.')
    expect(consola.info).toHaveBeenCalledWith('source 0 (design): 1 added, 0 removed, 0 renamed, 1 disambiguated')
    expect(consola.info).toHaveBeenCalledWith('disambiguated: bell → bell-1-3 (1:3)')
    expect(consola.info).toHaveBeenCalledWith('public names added: bell')
    expect(consola.warn).toHaveBeenCalledWith(expect.stringContaining('Public-name deletions are unknown'))
    const grouped = vi.mocked(consola.warn).mock.calls.map(call => String(call[0])).find(text => text.includes(message))!
    expect(grouped.split(message)).toHaveLength(2)
    expect(grouped).toContain('node: 1:2')
    expect(grouped).toContain('node: 1:3')
    expect(grouped).toContain('path: "Icons"')
    expect(grouped).toContain('proposed: "bell-1-3"')
    expect(process.exitCode).toBe(0)
  })

  it.each(['--continue', '--offline'])('rejects %s before loading config or fetching the document', async (flag) => {
    await expect(runCli(['node', 'iconctl', 'preflight', flag, '--json'])).rejects.toThrow(`${flag} is not supported by preflight`)
    expect(JSON.parse(output)).toMatchObject({ success: false, command: 'preflight', error: { phase: 'arguments' } })
    expect(loadConfig).not.toHaveBeenCalled()
    expect(preflightFigmaNaming).not.toHaveBeenCalled()
  })

  it('accepts dry-run as a no-op because preflight never writes icon outputs', async () => {
    await runCli(['node', 'iconctl', 'preflight', '--dry-run', '--json'])
    expect(preflightFigmaNaming).toHaveBeenCalledWith({ cwd: process.cwd(), config: await vi.mocked(loadConfig).mock.results[0]!.value })
    expect(JSON.parse(output).outputFiles).toEqual([])
  })
})
