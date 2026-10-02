import type { Project, Release, Snapshot } from '@iconctl/console-contracts'
import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { test as base } from '@playwright/test'

interface ReleaseComparisonFixture {
  project: Project
  snapshots: [Snapshot, Snapshot, Snapshot]
  release: Release
  session: { token: string, csrf: string, expiresAt: number }
}

interface LocalWorker<Fixture> {
  origin: string
  fixture: Fixture
  unexpectedRequests: string[]
}

export function createWorkerTest<Fixture>(fixtureName: string) {
  return base.extend<{ localWorker: LocalWorker<Fixture> }>({
    localWorker: async ({ request }, use) => {
    // Give each test ownership of its service process and communicate with the
    // same HTTP boundary used by the browser.
      const child = spawn(process.execPath, [fileURLToPath(new URL('./worker-server.mjs', import.meta.url)), fixtureName], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      const unexpectedRequests: string[] = []
      let diagnostics = ''
      const capture = (chunk: Buffer) => {
        diagnostics = `${diagnostics}${chunk}`.slice(-16_000)
      }
      child.stdout?.on('data', capture)
      child.stderr?.on('data', capture)
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
      const ready = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Local Worker startup timed out\n${diagnostics}`)), 20_000)
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('close', (code) => {
          clearTimeout(timer)
          reject(new Error(`Local Worker exited (${code})\n${diagnostics}`))
        })
        child.on('message', (message: { type?: string, origin?: string, request?: string }) => {
          if (message.type === 'ready' && message.origin) {
            clearTimeout(timer)
            resolve(message.origin)
          }
          if (message.type === 'unexpected-request' && message.request) {
            unexpectedRequests.push(message.request)
          }
        })
      })
      try {
        const origin = await ready
        const response = await request.post(`${origin}/__fixtures/${fixtureName}`)
        if (!response.ok()) {
          throw new Error(`Could not seed browser fixture: ${response.status()} ${await response.text()}`)
        }
        const fixture = await response.json() as Fixture
        await use({ origin, fixture, unexpectedRequests })
      }
      finally {
        if (child.connected) {
          child.send({ type: 'stop' })
        }
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
        await closed
        clearTimeout(killTimer)
      }
    },
  })
}

export const test = createWorkerTest<ReleaseComparisonFixture>('release-comparison')

export { expect } from '@playwright/test'
