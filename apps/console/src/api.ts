let csrf = ''
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      'Idempotency-Key': crypto.randomUUID(),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (response.status === 401) {
    location.assign('/login')
    throw new Error('请重新登录')
  }
  const result = await response.json()
  if (!response.ok) {
    throw new Error(result.error ?? `请求失败（${response.status}）`)
  }
  return result as T
}
export async function initializeSession() {
  const session = await api<{ csrf: string }>('session')
  csrf = session.csrf
}
export async function upload(file: File) {
  const response = await fetch('/api/uploads', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/zip', 'X-CSRF-Token': csrf },
    body: file,
  })
  const result = (await response.json()) as { id: string, error?: string }
  if (!response.ok) {
    throw new Error(result.error ?? '上传失败')
  }
  return result.id
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
  const result = (await response.json()) as {
    restored: number
    error?: string
  }
  if (!response.ok) {
    throw new Error(result.error ?? '恢复失败')
  }
  return result.restored
}
