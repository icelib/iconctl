import { safePath } from '@iconctl/console-contracts'
import { Zip, ZipPassThrough } from 'fflate/browser'
import { fail } from './security'

export const MAX_SVG_ARCHIVE_DOCUMENT_BYTES = 8 * 1024 * 1024
export const MAX_SVG_ARCHIVE_BYTES = 5 * 1024 * 1024
export const MAX_SVG_ARCHIVE_FILE_BYTES = 1024 * 1024
export const MAX_SVG_ARCHIVE_FILES = 5000

interface Entry {
  name: string
  encoded: string
}

function decodedLength(value: string) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const length = value.length / 4 * 3 - padding
  if (length > MAX_SVG_ARCHIVE_FILE_BYTES) {
    fail(413, 'An SVG artifact exceeds the 1 MiB archive limit')
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (
    value.length % 4 !== 0
    || /[^A-Z\d+/=]/i.test(value)
    || (value.includes('=') && value.indexOf('=') !== value.length - padding)
    || (padding > 0 && (alphabet.indexOf(value[value.length - padding - 1]!) & (padding === 2 ? 15 : 3)) !== 0)
  ) {
    fail(409, 'Snapshot contains invalid SVG artifact encoding')
  }
  return length
}

function selectEntries(files: unknown): Entry[] {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    fail(409, 'Snapshot contains invalid artifact files')
  }
  const entries: Entry[] = []
  let bytes = 0
  for (const [name, encoded] of Object.entries(files)) {
    if (!name.startsWith('svg/') || !/\.svg$/i.test(name)) {
      continue
    }
    if (!safePath.safeParse(name).success || new TextDecoder().decode(new TextEncoder().encode(name)) !== name || typeof encoded !== 'string') {
      fail(409, 'Snapshot contains an unsafe SVG artifact path or value')
    }
    bytes += decodedLength(encoded)
    if (entries.length >= MAX_SVG_ARCHIVE_FILES || bytes > MAX_SVG_ARCHIVE_BYTES) {
      fail(413, 'SVG archive exceeds 5000 files or 5 MiB of SVG data')
    }
    entries.push({ name, encoded })
  }
  if (!entries.length) {
    fail(404, 'Snapshot has no SVG artifacts')
  }
  const names = new Set(entries.map(entry => entry.name))
  for (const { name } of entries) {
    const parts = name.split('/')
    for (let index = 1; index < parts.length; index++) {
      if (names.has(parts.slice(0, index).join('/'))) {
        fail(409, 'Snapshot contains conflicting SVG artifact paths')
      }
    }
  }
  return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/** Validate everything before responding, then decode only one member per pull. */
export function svgArchive(files: unknown, signal?: AbortSignal): ReadableStream<Uint8Array> {
  let entries: (Entry | undefined)[] = selectEntries(files)
  let index = 0
  let zip: Zip | undefined
  let ended = false
  let abort: (() => void) | undefined

  function cleanup() {
    ended = true
    zip?.terminate()
    zip = undefined
    entries = []
    if (abort) {
      signal?.removeEventListener('abort', abort)
      abort = undefined
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((error, data, final) => {
        if (ended) {
          return
        }
        if (error) {
          cleanup()
          controller.error(error)
          return
        }
        controller.enqueue(data)
        if (final) {
          cleanup()
          controller.close()
        }
      })
      abort = () => {
        cleanup()
        controller.error(signal?.reason ?? new DOMException('Download canceled', 'AbortError'))
      }
      if (signal?.aborted) {
        abort()
      }
      else {
        signal?.addEventListener('abort', abort, { once: true })
      }
    },
    pull(controller) {
      if (ended) {
        return
      }
      try {
        const entry = entries[index]
        if (!entry) {
          zip!.end()
          return
        }
        entries[index++] = undefined
        const binary = atob(entry.encoded)
        const bytes = new Uint8Array(binary.length)
        for (let offset = 0; offset < binary.length; offset++) {
          bytes[offset] = binary.charCodeAt(offset)
        }
        const file = new ZipPassThrough(entry.name)
        // Local components give identical DOS timestamps across time zones.
        file.mtime = new Date(1980, 0, 1)
        file.os = 0
        file.attrs = 0
        zip!.add(file)
        file.push(bytes, true)
      }
      catch (error) {
        cleanup()
        controller.error(error)
      }
    },
    cancel: cleanup,
  }, { highWaterMark: 0 })
}
