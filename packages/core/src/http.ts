import { throwIfAborted } from './abort'
import { IconctlError } from './errors'

export async function fetchText(url: string, init?: RequestInit): Promise<string> {
  throwIfAborted(init?.signal ?? undefined)
  try {
    const response = await fetch(url, init)
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new IconctlError(`Request failed ${response.status} for ${url}${body ? `: ${body.slice(0, 300)}` : ''}`)
    }
    const text = await response.text()
    throwIfAborted(init?.signal ?? undefined)
    return text
  }
  catch (error) {
    throwIfAborted(init?.signal ?? undefined)
    throw error
  }
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
