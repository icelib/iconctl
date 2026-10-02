const SETTINGS = 'iconctl-settings'
const PREFERENCES = 'iconctl-preflight-preferences'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function makeFixture(records = new Map<string, unknown>()) {
  vi.resetModules()
  const messages: Record<string, unknown>[] = []
  const handlers = new Map<string, () => void>()
  const storage = {
    getAsync: vi.fn(async (key: string): Promise<unknown> => records.get(key)),
    setAsync: vi.fn(async (key: string, value: unknown) => { records.set(key, value) }),
    deleteAsync: vi.fn(async (key: string) => { records.delete(key) }),
  }
  const host = {
    showUI: vi.fn(),
    currentPage: { id: 'page', type: 'PAGE', children: [] },
    clientStorage: storage,
    ui: { postMessage: (message: Record<string, unknown>) => messages.push(message), onmessage: undefined as ((message: Record<string, unknown>) => Promise<void>) | undefined },
    on: (event: string, callback: () => void) => handlers.set(event, callback),
  }
  vi.stubGlobal('figma', host)
  vi.stubGlobal('__html__', '<html></html>')
  await import('../src/code')
  const send = (message: Record<string, unknown>) => host.ui.onmessage!(message)
  const feedback = (scope: string) => messages.filter(message => message['type'] === 'storage-status' && message['scope'] === scope)
  return { records, storage, messages, send, feedback, close: () => handlers.get('close')!() }
}

afterEach(() => vi.unstubAllGlobals())

it('waits for UI readiness and restores both domains without reading device or task keys', async () => {
  const legacy = { repo: 'owner/icons', token: 'saved-token', eventType: 'sync' }
  const records = new Map<string, unknown>([[SETTINGS, legacy], [PREFERENCES, { problemsOnly: true }], ['iconctl-console-device', { id: 'device' }]])
  const fixture = await makeFixture(records)
  expect(fixture.storage.getAsync).not.toHaveBeenCalled()
  await fixture.send({ type: 'load-settings' })
  expect(fixture.storage.getAsync.mock.calls.map(([key]) => key).sort()).toEqual([PREFERENCES, SETTINGS].sort())
  expect(fixture.messages).toContainEqual({ type: 'settings', settings: legacy })
  expect(fixture.messages).toContainEqual({ type: 'preferences', preferences: { problemsOnly: true } })
  expect(fixture.storage.setAsync).not.toHaveBeenCalled()
  expect(fixture.records.get('iconctl-console-device')).toEqual({ id: 'device' })
})

it('retains valid legacy fields, rejects malformed values and never echoes storage exceptions', async () => {
  const fixture = await makeFixture(new Map<string, unknown>([[SETTINGS, { repo: 'owner/icons', token: { secret: 'corrupt-token' }, eventType: 12, extra: 'discard' }], [PREFERENCES, { problemsOnly: 'true' }]]))
  await fixture.send({ type: 'load-settings' })
  expect(fixture.messages).toContainEqual({ type: 'settings', settings: { repo: 'owner/icons' } })
  expect(fixture.messages).toContainEqual({ type: 'preferences', preferences: { problemsOnly: false } })
  expect(fixture.feedback('settings').at(-1)).toMatchObject({ operation: 'load', error: true })
  expect(fixture.feedback('preferences').at(-1)).toMatchObject({ operation: 'load', error: true })
  expect(JSON.stringify(fixture.messages)).not.toContain('corrupt-token')
  expect(fixture.storage.setAsync).not.toHaveBeenCalled()
})

it('handles missing data and rejects malformed save requests without writing', async () => {
  const fixture = await makeFixture()
  await fixture.send({ type: 'load-settings' })
  expect(fixture.messages).toContainEqual({ type: 'settings', settings: {} })
  expect(fixture.messages).toContainEqual({ type: 'preferences', preferences: { problemsOnly: false } })
  for (const preferences of [null, [], { problemsOnly: 1 }, { problemsOnly: 'false' }]) {
    await fixture.send({ type: 'save-preferences', preferences })
  }
  await fixture.send({ type: 'save-settings', settings: { token: 2 } })
  expect(fixture.storage.setAsync).not.toHaveBeenCalled()
})

it('restores one domain when another fails, and retries the failed load', async () => {
  const fixture = await makeFixture(new Map<string, unknown>([[PREFERENCES, { problemsOnly: true }]]))
  fixture.storage.getAsync.mockImplementation(async (key) => {
    if (key === SETTINGS) {
      throw new Error('private-token-in-provider-error')
    }
    return fixture.records.get(key)
  })
  await fixture.send({ type: 'load-settings' })
  expect(fixture.messages).toContainEqual({ type: 'preferences', preferences: { problemsOnly: true } })
  expect(fixture.feedback('settings').at(-1)).toMatchObject({ operation: 'load', error: true })
  expect(JSON.stringify(fixture.feedback('settings'))).not.toContain('private-token')
  fixture.storage.getAsync.mockResolvedValueOnce({ repo: 'restored/icons' })
  await fixture.send({ type: 'retry-storage', scope: 'settings' })
  expect(fixture.messages).toContainEqual({ type: 'settings', settings: { repo: 'restored/icons' } })
  expect(fixture.feedback('settings').at(-1)).toMatchObject({ error: false })
})

it('suppresses a stale load in the saved domain while allowing the other domain to restore', async () => {
  const fixture = await makeFixture()
  const pending = deferred<unknown>()
  fixture.storage.getAsync.mockImplementation(async key => key === SETTINGS ? pending.promise : { problemsOnly: true })
  const loading = fixture.send({ type: 'load-settings' })
  await fixture.send({ type: 'save-settings', settings: { repo: 'new/icons', token: 'new-token' } })
  pending.resolve({ repo: 'old/icons' })
  await loading
  expect(fixture.messages.filter(message => message['type'] === 'settings')).toEqual([])
  expect(fixture.messages).toContainEqual({ type: 'preferences', preferences: { problemsOnly: true } })
  expect(fixture.records.get(SETTINGS)).toEqual({ repo: 'new/icons', token: 'new-token' })
})

it('serializes saves, suppresses an older failure and persists the latest value', async () => {
  const fixture = await makeFixture()
  const first = deferred<void>()
  fixture.storage.setAsync.mockImplementationOnce(async () => first.promise)
  const oldSave = fixture.send({ type: 'save-preferences', preferences: { problemsOnly: true } })
  await vi.waitFor(() => expect(fixture.storage.setAsync).toHaveBeenCalledTimes(1))
  const newSave = fixture.send({ type: 'save-preferences', preferences: { problemsOnly: false } })
  expect(fixture.storage.setAsync).toHaveBeenCalledTimes(1)
  first.reject(new Error('storage failure'))
  await Promise.all([oldSave, newSave])
  expect(fixture.records.get(PREFERENCES)).toEqual({ problemsOnly: false })
  expect(fixture.feedback('preferences')).toEqual([expect.objectContaining({ operation: 'save', error: false })])
})

it('retries a failed save with current form values and restores it when reopened', async () => {
  const fixture = await makeFixture()
  fixture.storage.setAsync.mockRejectedValueOnce(new Error('secret-write-error'))
  await fixture.send({ type: 'save-settings', settings: { repo: 'before/icons', token: 'before-token' } })
  expect(fixture.feedback('settings').at(-1)).toMatchObject({ operation: 'save', error: true })
  expect(JSON.stringify(fixture.feedback('settings'))).not.toContain('secret-write-error')
  await fixture.send({ type: 'retry-storage', scope: 'settings', settings: { repo: 'after/icons', token: 'after-token' } })
  expect(fixture.records.get(SETTINGS)).toEqual({ repo: 'after/icons', token: 'after-token' })
  expect(fixture.feedback('settings').at(-1)).toMatchObject({ error: false })
  await fixture.send({ type: 'save-preferences', preferences: { problemsOnly: true } })
  fixture.close()
  const reopened = await makeFixture(fixture.records)
  await reopened.send({ type: 'load-settings' })
  expect(reopened.messages).toContainEqual({ type: 'settings', settings: { repo: 'after/icons', token: 'after-token' } })
  expect(reopened.messages).toContainEqual({ type: 'preferences', preferences: { problemsOnly: true } })
})

it('suppresses late load replies and ignores new requests after close', async () => {
  const fixture = await makeFixture()
  const pending = deferred<unknown>()
  fixture.storage.getAsync.mockImplementation(async () => pending.promise)
  const loading = fixture.send({ type: 'load-settings' })
  fixture.close()
  const previous = [...fixture.messages]
  pending.reject(new Error('late private exception'))
  await loading
  await fixture.send({ type: 'save-preferences', preferences: { problemsOnly: true } })
  await fixture.send({ type: 'load-settings' })
  expect(fixture.messages).toEqual(previous)
  expect(fixture.storage.setAsync).not.toHaveBeenCalled()
  expect(fixture.storage.getAsync).toHaveBeenCalledTimes(2)
})

it('allows an in-flight write to settle on close but skips queued writes and replies', async () => {
  const fixture = await makeFixture()
  const first = deferred<void>()
  fixture.storage.setAsync.mockImplementationOnce(async (key, value) => {
    await first.promise
    fixture.records.set(key, value)
  })
  const active = fixture.send({ type: 'save-settings', settings: { repo: 'active/icons' } })
  await vi.waitFor(() => expect(fixture.storage.setAsync).toHaveBeenCalledTimes(1))
  const queued = fixture.send({ type: 'save-preferences', preferences: { problemsOnly: true } })
  fixture.close()
  const previous = [...fixture.messages]
  first.resolve()
  await Promise.all([active, queued])
  expect(fixture.storage.setAsync).toHaveBeenCalledTimes(1)
  expect(fixture.records.get(SETTINGS)).toEqual({ repo: 'active/icons' })
  expect(fixture.records.has(PREFERENCES)).toBe(false)
  expect(fixture.messages).toEqual(previous)
})
export {}
