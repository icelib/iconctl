import { readApiResponse, readZipResponse } from './api-response'

export { ApiError } from './api-response'

let csrf = ''

interface RequestOptions {
  signal?: AbortSignal
  idempotencyKey?: string
}

async function readResponse<T>(response: Response, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (response.status === 401) {
    location.assign('/login')
  }
  const value = await readApiResponse<T>(response)
  signal?.throwIfAborted()
  return value
}

export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  options: RequestOptions = {},
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      'Idempotency-Key': options.idempotencyKey ?? crypto.randomUUID(),
    },
    signal: options.signal,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return await readResponse<T>(response, options.signal)
}
export async function initializeSession(signal?: AbortSignal) {
  const session = await api<{ csrf: string }>('session', undefined, 'GET', { signal })
  signal?.throwIfAborted()
  csrf = session.csrf
}
export async function upload(file: File, signal?: AbortSignal) {
  const response = await fetch('/api/uploads', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/zip', 'X-CSRF-Token': csrf },
    body: file,
    signal,
  })
  signal?.throwIfAborted()
  const result = await readResponse<{ id: string }>(response, signal)
  return result.id
}

export async function downloadSnapshotSvg(id: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(`/api/snapshots/${id}/svg.zip`, { credentials: 'same-origin', signal })
  signal.throwIfAborted()
  if (response.status === 401) {
    location.assign('/login')
  }
  return await readZipResponse(response, signal)
}

export async function restoreBackup(file: File) {
  const response = await fetch('/api/restore', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-CSRF-Token': csrf,
    },
    body: file,
  })
  const result = await readResponse<{ restored: number }>(response)
  return result.restored
}
