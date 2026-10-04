import type { Locator } from '@playwright/test'

export type ClipboardMode = 'native' | 'missing' | 'throw' | 'reject' | 'pending' | 'success'
export interface ClipboardEvidence {
  mode: ClipboardMode
  environment: { url: string, topUrl: string, secure: boolean, nativeApi: boolean, writeAllowed: boolean | null, readAllowed: boolean | null }
  writes: { value: string, activation: boolean, settled?: 'success' | 'failure', error?: string }[]
  active: number
  peak: number
  completedPayload?: string
  readCalls: number
  testReadCalls: number
  permissionCalls: number
  execCalls: number
}
interface ClipboardHarness extends ClipboardEvidence {
  pending: { done: boolean, finish: (success: boolean) => void }[]
  setMode: (mode: ClipboardMode) => void
  nativeRead: () => Promise<string>
}
interface ClipboardWindow { copyHarness: ClipboardHarness }

/** Instrument only the browser Clipboard boundary; never the product controller. */
export async function installClipboard(target: Locator, initialMode: ClipboardMode) {
  await target.evaluate((_element, initialMode) => {
    const originalClipboard = navigator.clipboard
    const nativeWrite = originalClipboard?.writeText.bind(originalClipboard)
    const nativeRead = originalClipboard?.readText.bind(originalClipboard)
    const policy = (document as unknown as { permissionsPolicy?: { allowsFeature: (name: string) => boolean }, featurePolicy?: { allowsFeature: (name: string) => boolean } }).permissionsPolicy ?? (document as unknown as { featurePolicy?: { allowsFeature: (name: string) => boolean } }).featurePolicy
    const harness: ClipboardHarness = {
      mode: initialMode,
      environment: { url: location.href, topUrl: top!.location.href, secure: isSecureContext, nativeApi: !!nativeWrite, writeAllowed: policy?.allowsFeature('clipboard-write') ?? null, readAllowed: policy?.allowsFeature('clipboard-read') ?? null },
      writes: [],
      pending: [],
      active: 0,
      peak: 0,
      readCalls: 0,
      testReadCalls: 0,
      permissionCalls: 0,
      execCalls: 0,
      setMode(mode) {
        harness.mode = mode
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: mode === 'missing'
            ? undefined
            : {
                readText() {
                  harness.readCalls++
                  return Promise.reject(new Error('Product must not read clipboard'))
                },
                writeText(value: string) {
                  const record: ClipboardEvidence['writes'][number] = { value, activation: navigator.userActivation.isActive }
                  harness.writes.push(record)
                  harness.active++
                  harness.peak = Math.max(harness.peak, harness.active)
                  const finish = (success: boolean, error?: string) => {
                    harness.active--
                    record.settled = success ? 'success' : 'failure'
                    if (error) {
                      record.error = error
                    }
                    if (success) {
                      harness.completedPayload = value
                    }
                  }
                  if (harness.mode === 'throw') {
                    finish(false, 'SynchronousFixtureError')
                    throw new Error('Controlled synchronous clipboard failure')
                  }
                  if (harness.mode === 'reject') {
                    finish(false, 'NotAllowedError')
                    return Promise.reject(new DOMException('Controlled clipboard rejection', 'NotAllowedError'))
                  }
                  if (harness.mode === 'pending') {
                    return new Promise<void>((resolve, reject) => {
                      const gate = { done: false, finish(success: boolean) {
                        if (gate.done) {
                          return
                        }
                        gate.done = true
                        finish(success, success ? undefined : 'NotAllowedError')
                        if (success) {
                          resolve()
                        }
                        else {
                          reject(new DOMException('Controlled late clipboard rejection', 'NotAllowedError'))
                        }
                      } }
                      harness.pending.push(gate)
                    })
                  }
                  if (harness.mode === 'native') {
                    try {
                      return nativeWrite!(value).then(() => finish(true), (error) => {
                        finish(false, error instanceof Error ? error.name : String(error))
                        throw error
                      })
                    }
                    catch (error) {
                      finish(false, error instanceof Error ? error.name : String(error))
                      throw error
                    }
                  }
                  finish(true)
                  return Promise.resolve()
                },
              },
        })
      },
      nativeRead: async () => {
        harness.testReadCalls++
        return nativeRead!()
      },
    }
    const query = navigator.permissions.query.bind(navigator.permissions)
    navigator.permissions.query = (descriptor) => {
      harness.permissionCalls++
      return query(descriptor)
    }
    const exec = document.execCommand.bind(document)
    document.execCommand = (...args) => {
      harness.execCalls++
      return exec(...args)
    }
    ;(window as unknown as ClipboardWindow).copyHarness = harness
    harness.setMode(initialMode)
  }, initialMode)
  return {
    setMode: (mode: ClipboardMode) => target.evaluate((_element, mode) => (window as unknown as ClipboardWindow).copyHarness.setMode(mode), mode),
    evidence: () => target.evaluate(() => {
      const { pending: _pending, setMode: _set, nativeRead: _read, ...evidence } = (window as unknown as ClipboardWindow).copyHarness
      return evidence
    }),
    settle: (index: number, success: boolean) => target.evaluate((_element, { index, success }) => (window as unknown as ClipboardWindow).copyHarness.pending[index]!.finish(success), { index, success }),
    releaseAll: () => target.evaluate(() => {
      for (const gate of (window as unknown as ClipboardWindow).copyHarness.pending) {
        gate.finish(false)
      }
    }),
    readOwnNativeWrite: () => target.evaluate(() => (window as unknown as ClipboardWindow).copyHarness.nativeRead()),
  }
}
export type ClipboardFixture = Awaited<ReturnType<typeof installClipboard>>
