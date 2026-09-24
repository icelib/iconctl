import type { FigmaLoginOptions } from '@iconctl/core'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { runCli } from '../src/program'

const { login, spawn } = vi.hoisted(() => ({ login: vi.fn(), spawn: vi.fn() }))
vi.mock('@iconctl/core', async original => ({ ...await original<typeof import('@iconctl/core')>(), loginFigma: login }))
vi.mock('node:child_process', () => ({ spawn }))

let directory: string
let file: string
let output: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'iconctl-cli-auth-'))
  file = join(directory, 'figma.json')
  output = ''
  for (const key of ['FIGMA_TOKEN', 'FIGMA_CLIENT_ID', 'FIGMA_CLIENT_SECRET', 'FIGMA_REFRESH_TOKEN']) {
    vi.stubEnv(key, '')
  }
  vi.stubEnv('ICONCTL_FIGMA_CREDENTIALS_FILE', file)
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
    output += String(text)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  await writeFile(file, JSON.stringify({ version: 1, clientId: 'client', clientSecret: 'hidden-client-secret', accessToken: 'hidden-access', refreshToken: 'hidden-refresh', expiresAt: 1 }))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  process.exitCode = 0
  await rm(directory, { recursive: true, force: true })
})

it('routes auth status without loading a project config and emits only metadata', async () => {
  await runCli(['node', 'iconctl', 'auth', 'figma', 'status', '--json', '--config', join(directory, 'nonexistent.ts')])
  expect(JSON.parse(output)).toEqual({ source: 'local-oauth', expiresAt: 1, expired: true })
  expect(output).not.toContain('hidden')
})

it('routes login options and cleans up signal listeners', async () => {
  login.mockImplementation(async (options: FigmaLoginOptions) => {
    expect(options.redirectUri).toBe('http://127.0.0.1:53683/callback')
    await options.onAuthorize('https://www.figma.com/oauth?state=test')
  })
  const before = process.listenerCount('SIGINT')
  await runCli(['node', 'iconctl', 'auth', 'figma', 'login', '--no-open', '--redirect-uri', 'http://127.0.0.1:53683/callback', '--json'])
  expect(JSON.parse(output)).toEqual({ success: true, action: 'login' })
  expect(spawn).not.toHaveBeenCalled()
  expect(process.listenerCount('SIGINT')).toBe(before)
})

it('deletes local credentials on logout without printing their contents', async () => {
  await runCli(['node', 'iconctl', 'auth', 'figma', 'logout', '--json'])
  expect(JSON.parse(output)).toEqual({ success: true, action: 'logout' })
  await expect(readFile(file)).rejects.toThrow()
  expect(output).not.toContain('hidden')
})

it('rejects unsupported auth actions', async () => {
  await expect(runCli(['node', 'iconctl', 'auth', 'figma', 'unsupported'])).rejects.toThrow('login')
})
