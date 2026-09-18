import { IconctlError } from './errors'

export async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new IconctlError(`Request failed ${response.status} for ${url}${body ? `: ${body.slice(0, 300)}` : ''}`)
  }
  return await response.text()
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const text = await fetchText(url, init)
  try {
    return JSON.parse(text) as T
  }
  catch (error) {
    throw new IconctlError(`Invalid JSON from ${url}`, { cause: error })
  }
}
