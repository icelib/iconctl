import { iconJsonSchema } from '@iconctl/console-contracts'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** Preserve the HTTP status even when a proxy returns an HTML error document. */
export async function readApiResponse<T>(response: Pick<Response, 'status' | 'ok' | 'json'>): Promise<T> {
  if (response.status === 401) {
    throw new ApiError('请重新登录', 401)
  }
  let result: unknown
  try {
    result = await response.json()
  }
  catch {
    throw new ApiError(response.ok ? '服务器响应格式无效，请重试' : `请求失败（${response.status}）`, response.status)
  }
  if (!response.ok) {
    const message = typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string'
      ? result.error
      : `请求失败（${response.status}）`
    throw new ApiError(message, response.status)
  }
  return result as T
}

/** Binary downloads share API errors, but must never save error HTML/JSON as ZIP. */
export async function readZipResponse(response: Response, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted()
  if (!response.ok) {
    await readApiResponse(response)
  }
  if (response.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/zip') {
    throw new ApiError('服务器响应格式无效，请重试', response.status)
  }
  const blob = await response.blob()
  signal.throwIfAborted()
  return blob
}

/** Keep stored JSON bytes after rejecting error envelopes and malformed collections. */
export async function readIconJsonResponse(response: Response, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted()
  if (!response.ok) {
    await readApiResponse(response)
  }
  if (response.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json') {
    throw new ApiError('服务器响应格式无效，请重试', response.status)
  }
  const blob = await response.blob()
  signal.throwIfAborted()
  let collection: unknown
  try {
    collection = JSON.parse(await blob.text())
  }
  catch {
    signal.throwIfAborted()
    throw new ApiError('服务器响应格式无效，请重试', response.status)
  }
  signal.throwIfAborted()
  if (!iconJsonSchema.safeParse(collection).success) {
    throw new ApiError('服务器图标集合无效，请重试', response.status)
  }
  return blob
}
