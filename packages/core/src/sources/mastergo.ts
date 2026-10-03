import type { LoadedSource, ResolvedMastergoSourceConfig } from './types'
import { blankIconSet } from '@iconify/tools'
import { checkpoint, throwIfAborted } from '../abort'
import { IconctlError } from '../errors'
import { fetchJson } from '../http'
import { addSvgToIconSet, stripIconPrefix } from '../icon-set'
import { resolveMastergoToken } from '../token'

export interface MastergoExtractSvgResponse {
  totalCount?: number
  count?: number
  svgs?: Array<{ name?: string, id?: string, svg?: string }>
  page?: number
  pageSize?: number
  hasMore?: boolean
}

export function parseMastergoRef(input: {
  file?: string
  fileId?: string
  layerId?: string
}): { fileId: string, layerId: string } {
  let fileId = input.fileId?.trim()
  let layerId = input.layerId?.trim()
  const file = input.file?.trim()
  if (file) {
    const fileMatch = file.match(/\/file\/(\d+)/)
    const layerMatch = file.match(/[?&]layer_id=([^&]+)/i)
    if (fileMatch?.[1]) {
      fileId = fileMatch[1]
    }
    if (layerMatch?.[1]) {
      layerId = decodeURIComponent(layerMatch[1])
    }
  }
  if (!fileId || !layerId) {
    throw new IconctlError('iconctl mastergo source needs a file URL with layer_id, or fileId + layerId. Example: https://mastergo.com/file/<fileId>?layer_id=<pageId>')
  }
  return { fileId, layerId }
}

function mastergoError(statusMessage: string): string {
  const lower = statusMessage.toLowerCase()
  if (lower.includes('token') || lower.includes('401') || lower.includes('unauthorized')) {
    return `${statusMessage} Create a personal access token in MasterGo 个人设置 → 安全设置, then set MASTERGO_TOKEN. Team edition is required; files must live in a team project, not the draft box.`
  }
  if (lower.includes('permission') || lower.includes('403') || lower.includes('draft')) {
    return `${statusMessage} MasterGo MCP access needs a Team edition account, and the file must be in a team project.`
  }
  return statusMessage
}

export async function loadMastergoSource(
  source: ResolvedMastergoSourceConfig,
  options: { prefix: string, env?: NodeJS.Dict<string>, signal?: AbortSignal },
): Promise<LoadedSource> {
  await checkpoint(options.signal)
  const token = resolveMastergoToken(source.token, options.env)
  const headers = {
    'Accept': 'application/json',
    'X-MG-UserAccessToken': token,
  }
  const iconSet = blankIconSet(options.prefix)
  const failures: NonNullable<LoadedSource['failures']> = []
  let page = 0
  const pageSize = 100

  try {
    while (true) {
      await checkpoint(options.signal)
      const url = new URL('/mcp/extract-svg', source.baseUrl)
      url.searchParams.set('fileId', source.fileId)
      url.searchParams.set('layerId', source.layerId)
      url.searchParams.set('page', String(page))
      url.searchParams.set('pageSize', String(pageSize))
      const payload = await fetchJson<MastergoExtractSvgResponse>(url.toString(), { headers, ...(options.signal ? { signal: options.signal } : {}) })
      if (!Array.isArray(payload.svgs)) {
        throw new IconctlError('Invalid MasterGo extract-svg response: missing SVG list.')
      }
      for (const [index, item] of payload.svgs.entries()) {
        await checkpoint(options.signal)
        const fallback = `item-${page * pageSize + index + 1}`
        const rawName = (typeof item?.name === 'string' && item.name) || (typeof item?.id === 'string' && item.id)
        if (!rawName) {
          failures.push({ name: fallback, message: 'MasterGo returned an icon without a name or id.' })
          continue
        }
        const name = stripIconPrefix(rawName, '')
        if (!name) {
          failures.push({ name: rawName, message: 'The MasterGo icon name cannot be converted to an icon name.' })
          continue
        }
        if (typeof item.svg !== 'string' || !item.svg.trim()) {
          failures.push({ name, message: 'MasterGo did not return SVG content for this icon.' })
          continue
        }
        try {
          addSvgToIconSet(iconSet, name, item.svg)
        }
        catch {
          failures.push({ name, message: 'MasterGo returned an invalid SVG for this icon.' })
        }
      }
      if (payload.hasMore === true) {
        page += 1
        continue
      }
      break
    }
  }
  catch (error) {
    throwIfAborted(options.signal)
    if (error instanceof IconctlError) {
      throw new IconctlError(mastergoError(error.message), { cause: error })
    }
    throw error
  }

  const count = Object.keys(iconSet.export().icons).length
  if (!count && !failures.length) {
    throw new IconctlError(`MasterGo extract-svg returned no icons for file ${source.fileId} layer ${source.layerId}`)
  }

  return {
    type: 'mastergo',
    iconSet,
    notModified: false,
    fileKey: source.fileId,
    issues: failures.map(failure => ({ ...failure, stage: 'import', sourceType: 'mastergo', fileKey: source.fileId })),
    ...(failures.length ? { failures } : {}),
  }
}
