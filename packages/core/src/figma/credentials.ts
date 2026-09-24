import type { FigmaCredentials } from './oauth'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { lock } from 'proper-lockfile'
import { IconctlError } from '../errors'

export function figmaCredentialsPath(env: NodeJS.Dict<string> = process.env): string {
  const explicit = env['ICONCTL_FIGMA_CREDENTIALS_FILE']?.trim()
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new IconctlError('ICONCTL_FIGMA_CREDENTIALS_FILE must be an absolute path outside the repository.')
    }
    return explicit
  }
  return join(env['XDG_CONFIG_HOME'] || (process.platform === 'win32' ? env['APPDATA'] : undefined) || join(homedir(), '.config'), 'iconctl', 'figma.json')
}

export async function readFigmaCredentials(file: string): Promise<FigmaCredentials | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw new IconctlError('Cannot read Figma credentials. Check file permissions.')
  }
  try {
    const data = JSON.parse(text) as FigmaCredentials & { version: number }
    if (data.version !== 1 || !['clientId', 'clientSecret', 'accessToken', 'refreshToken'].every(key => typeof data[key as keyof FigmaCredentials] === 'string' && String(data[key as keyof FigmaCredentials]).trim())
      || typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt) || data.expiresAt <= 0) {
      throw new Error('invalid')
    }
    return { clientId: data.clientId, clientSecret: data.clientSecret, accessToken: data.accessToken, refreshToken: data.refreshToken, expiresAt: data.expiresAt }
  }
  catch {
    throw new IconctlError('Invalid Figma credentials file. Run `iconctl auth figma login` again.')
  }
}

export async function writeFigmaCredentials(file: string, credentials: FigmaCredentials, assertOwned: () => void = () => {}): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(temporary, `${JSON.stringify({ version: 1, ...credentials })}\n`, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    assertOwned()
    await rename(temporary, file)
  }
  catch {
    throw new IconctlError('Cannot save Figma credentials. Check file permissions and retry.')
  }
  finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function withFigmaCredentialsLock<T>(file: string, action: (assertOwned: () => void) => Promise<T>): Promise<T> {
  let compromised = false
  let release: () => Promise<void>
  const assertOwned = () => {
    if (compromised) {
      throw new IconctlError('Figma credentials lock was lost. Retry the operation.')
    }
  }
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    release = await lock(file, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 60, minTimeout: 500, maxTimeout: 500, factor: 1 },
      onCompromised: () => { compromised = true },
    })
  }
  catch {
    throw new IconctlError('Cannot lock Figma credentials. Another login or refresh may be running; retry later.')
  }
  try {
    const result = await action(assertOwned)
    assertOwned()
    return result
  }
  finally {
    await release().catch(() => {})
  }
}
