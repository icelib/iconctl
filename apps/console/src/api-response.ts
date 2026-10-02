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
