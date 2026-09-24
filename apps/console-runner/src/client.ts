import process from 'node:process'

export interface RunnerApi {
  request: (path: string, body?: unknown) => Promise<Response>
  json: <T>(path: string, body?: unknown) => Promise<T>
}
export class RunnerClient implements RunnerApi {
  constructor(
    readonly origin: string,
    readonly jobId: string,
  ) {
    if (new URL(origin).protocol !== 'https:') {
      throw new Error('Console origin must use HTTPS')
    }
  }

  private async oidc() {
    const endpoint = process.env['ACTIONS_ID_TOKEN_REQUEST_URL']
    const requestToken = process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']
    if (!endpoint || !requestToken) {
      throw new Error('GitHub Actions OIDC is required')
    }
    const url = new URL(endpoint)
    url.searchParams.set('audience', this.origin)
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${requestToken}` },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    })
    if (!response.ok) {
      throw new Error('Unable to obtain OIDC identity')
    }
    const data = (await response.json()) as { value?: string }
    if (!data.value) {
      throw new Error('Missing OIDC identity')
    }
    return data.value
  }

  async request(path: string, body?: unknown) {
    const response = await fetch(
      `${this.origin}/api/runner/${this.jobId}/${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Authorization': `Bearer ${await this.oidc()}`,
          'Content-Type': 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      },
    )
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string
      }
      throw new Error(
        `Console request failed (HTTP ${response.status}): ${typeof body.error === 'string' ? body.error : 'unavailable'}`,
      )
    }
    return response
  }

  async json<T>(path: string, body?: unknown): Promise<T> {
    return (await this.request(path, body)).json() as Promise<T>
  }
}
