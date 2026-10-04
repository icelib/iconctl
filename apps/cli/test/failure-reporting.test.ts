import { IconctlCheckError, IconctlSyncError } from '@iconctl/core'
import { consola } from 'consola'
import { runCli } from '../src/program'

const operations = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  sync: vi.fn(),
  check: vi.fn(),
  loginFigma: vi.fn(),
}))
vi.mock('@iconctl/core', async original => ({ ...await original<typeof import('@iconctl/core')>(), ...operations }))

describe('central CLI failure boundary', () => {
  let writes: string[]
  beforeEach(() => {
    writes = []
    process.exitCode = 0
    operations.loadConfig.mockResolvedValue({ output: {} })
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      writes.push(String(text))
      return true
    })
    vi.spyOn(consola, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    process.exitCode = 0
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  function report() {
    expect(writes).toHaveLength(1)
    expect(consola.error).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    return JSON.parse(writes[0]!)
  }

  it.each(['sync', 'preview'])('keeps original frozen errors and only serializes explicit diagnostics for %s', async (command) => {
    const issue = Object.assign({ name: 'renamed', message: 'Invalid canvas', stage: 'validation' as const, sourceType: 'figma', sourceIndex: 0, fileKey: 'file', nodeId: '1:2' }, {
      token: 'hidden-token',
      toJSON: () => { throw new Error('Do not serialize an arbitrary issue') },
    })
    const error = Object.freeze(Object.assign(new IconctlSyncError([issue]), {
      cause: { secret: 'hidden-cause' },
      config: { token: 'hidden-config' },
      toJSON: () => { throw new Error('Do not serialize an arbitrary error') },
    }))
    operations.sync.mockRejectedValue(error)
    await expect(runCli(['node', 'iconctl', command, '--json'])).rejects.toBe(error)
    expect(report()).toEqual({
      success: false,
      command,
      error: { name: 'IconctlSyncError', message: error.message, phase: 'execution', issues: [{ name: 'renamed', message: 'Invalid canvas', stage: 'validation', sourceType: 'figma', sourceIndex: 0, fileKey: 'file', nodeId: '1:2' }] },
    })
    expect(writes.join('')).not.toMatch(/hidden|stack|cause|outputFiles/)
  })

  it('reports config failures before execution without fabricating issues', async () => {
    const error = new Error('Cannot load configuration')
    operations.loadConfig.mockRejectedValue(error)
    await expect(runCli(['node', 'iconctl', 'sync', '--json'])).rejects.toBe(error)
    expect(report()).toEqual({ success: false, command: 'sync', error: { name: 'Error', message: error.message, phase: 'configuration' } })
    expect(operations.sync).not.toHaveBeenCalled()
  })

  it.each(['a string failure', 42, null, undefined])('preserves a thrown primitive: %s', async (error) => {
    operations.sync.mockRejectedValue(error)
    await expect(runCli(['node', 'iconctl', 'sync', '--json'])).rejects.toBe(error)
    expect(report().error).toEqual({ name: 'Error', message: String(error), phase: 'execution' })
  })

  it('does not invoke arbitrary serialization on a thrown object', async () => {
    const error = { token: 'hidden-token', toString: vi.fn(() => 'hidden-string'), toJSON: vi.fn(() => 'hidden-json') }
    operations.sync.mockRejectedValue(error)
    await expect(runCli(['node', 'iconctl', 'sync', '--json'])).rejects.toBe(error)
    expect(report().error).toEqual({ name: 'Error', message: 'Unknown error', phase: 'execution' })
    expect(error.toString).not.toHaveBeenCalled()
    expect(error.toJSON).not.toHaveBeenCalled()
  })

  it.each([
    ['sync', '--config', '--json'],
    ['preview', '--unknown', '--json'],
    ['auth', 'figma', '--json'],
  ])('uses parsed JSON options for parser failure: %s', async (...args) => {
    await expect(runCli(['node', 'iconctl', ...args])).rejects.toThrow()
    expect(report()).toMatchObject({ command: args[0], error: { name: 'CACError', phase: 'arguments' } })
    expect(operations.loadConfig).not.toHaveBeenCalled()
  })

  it.each([
    ['--json=false', '--unknown'],
    ['--no-json', '--unknown'],
    ['--unknown', '--', '--json'],
  ])('does not select JSON by scanning raw argv: %s', async (...args) => {
    await expect(runCli(['node', 'iconctl', 'sync', ...args])).rejects.toThrow()
    expect(writes).toEqual([])
    expect(consola.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Unknown option'))
    expect(process.exitCode).toBe(1)
  })

  it('prints a human execution failure once and rethrows the same error', async () => {
    const error = new Error('Readable execution failure')
    operations.sync.mockRejectedValue(error)
    await expect(runCli(['node', 'iconctl', 'sync'])).rejects.toBe(error)
    expect(writes).toEqual([])
    expect(consola.error).toHaveBeenCalledExactlyOnceWith(error.message)
  })

  it.each([['other', 'status'], ['figma', 'unsupported']])('classifies unsupported auth %s %s as arguments', async (provider, operation) => {
    await expect(runCli(['node', 'iconctl', 'auth', provider, operation, '--json'])).rejects.toThrow()
    expect(report()).toMatchObject({ command: 'auth', error: { phase: 'arguments' } })
    expect(operations.loginFigma).not.toHaveBeenCalled()
  })

  it('marks a real auth-command failure and restores signal listeners', async () => {
    const error = new Error('Authorization failed')
    operations.loginFigma.mockRejectedValue(error)
    const listeners = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))
    await expect(runCli(['node', 'iconctl', 'auth', 'figma', 'login', '--json'])).rejects.toBe(error)
    expect(report()).toMatchObject({ command: 'auth', error: { phase: 'authentication', message: error.message } })
    expect(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))).toEqual(listeners)
  })

  it('reports missing non-interactive init flags without prompting', async () => {
    const prompt = vi.spyOn(consola, 'prompt')
    await expect(runCli(['node', 'iconctl', 'init', '--json'])).rejects.toThrow('Non-interactive init requires')
    expect(report()).toMatchObject({ success: false, command: 'init', error: { phase: 'arguments' } })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('retains check report fields and copies the same safe issues into its envelope', async () => {
    const issue = Object.assign({ name: 'bad', file: 'icons.json', stage: 'validation' as const, message: 'Wrong dimensions' }, { secret: 'hidden-issue' })
    const error = new IconctlCheckError(Object.assign({ prefix: 'brand', count: 2, source: 'json' as const, valid: false, issues: [issue] }, { secret: 'hidden-report' }))
    operations.check.mockRejectedValue(error)
    await expect(runCli(['node', 'iconctl', 'check', '--input', 'icons.json', '--json'])).rejects.toBe(error)
    const value = report()
    expect(value).toEqual({ prefix: 'brand', count: 2, source: 'json', valid: false, issues: [{ name: 'bad', file: 'icons.json', stage: 'validation', message: 'Wrong dimensions' }], success: false, command: 'check', error: { name: 'IconctlCheckError', message: error.message, phase: 'execution', issues: value.issues } })
    expect(value.error.issues).toEqual(value.issues)
    expect(writes.join('')).not.toContain('hidden')
  })

  it('retains the fallback check report while identifying configuration failure', async () => {
    operations.loadConfig.mockRejectedValue(new Error('Bad config'))
    await expect(runCli(['node', 'iconctl', 'check', '--json'])).rejects.toThrow('Bad config')
    expect(report()).toMatchObject({ prefix: null, count: 0, source: null, valid: false, issues: [{ stage: 'options', message: 'Bad config' }], error: { phase: 'configuration' } })
  })

  it('keeps parser failures outside the watch runtime protocol', async () => {
    await expect(runCli(['node', 'iconctl', 'watch', '--unknown', '--json'])).rejects.toThrow()
    expect(writes).toEqual([])
    expect(consola.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Unknown option'))
    expect(process.exitCode).toBe(1)
  })

  it('keeps phase state private across overlapping invocations', async () => {
    let rejectConfig!: (error: Error) => void
    operations.loadConfig.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectConfig = reject
    }))
    const first = runCli(['node', 'iconctl', 'sync', '--json']).catch(error => error)
    operations.sync.mockRejectedValue(new Error('Second execution'))
    await expect(runCli(['node', 'iconctl', 'preview', '--json'])).rejects.toThrow('Second execution')
    rejectConfig(new Error('First config'))
    await first
    expect(writes.map(value => JSON.parse(value))).toMatchObject([
      { command: 'preview', error: { phase: 'execution' } },
      { command: 'sync', error: { phase: 'configuration' } },
    ])
  })
})
