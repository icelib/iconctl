import { readApiResponse, readZipResponse } from './api-response'

export { ApiError } from './api-response'

let csrf = ''

interface RequestOptions {
  signal?: AbortSignal
  idempotencyKey?: string
}

async function readResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    location.assign('/login')
  }
  return await readApiResponse<T>(response)
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
  return await readResponse<T>(response)
}
export async function initializeSession() {
  const session = await api<{ csrf: string }>('session')
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
  const result = await readResponse<{ id: string }>(response)
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
