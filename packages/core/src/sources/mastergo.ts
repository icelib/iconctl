import type { LoadedSource, ResolvedMastergoSourceConfig } from './types'
import { blankIconSet } from '@iconify/tools'
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
  options: { prefix: string, env?: NodeJS.Dict<string> },
): Promise<LoadedSource> {
  const token = resolveMastergoToken(source.token, options.env)
  const headers = {
    'Accept': 'application/json',
    'X-MG-UserAccessToken': token,
  }
  const iconSet = blankIconSet(options.prefix)
  let page = 0
  const pageSize = 100

  try {
    while (true) {
      const url = new URL('/mcp/extract-svg', source.baseUrl)
      url.searchParams.set('fileId', source.fileId)
      url.searchParams.set('layerId', source.layerId)
      url.searchParams.set('page', String(page))
      url.searchParams.set('pageSize', String(pageSize))
      const payload = await fetchJson<MastergoExtractSvgResponse>(url.toString(), { headers })
      const svgs = payload.svgs ?? []
      for (const item of svgs) {
        if (!item.svg) {
          continue
        }
        const rawName = item.name || item.id
        if (!rawName) {
          continue
        }
        const name = stripIconPrefix(rawName, '')
        if (!name) {
          continue
        }
        addSvgToIconSet(iconSet, name, item.svg)
      }
      if (payload.hasMore === true) {
        page += 1
        continue
      }
      break
    }
  }
  catch (error) {
    if (error instanceof IconctlError) {
      throw new IconctlError(mastergoError(error.message), { cause: error })
    }
    throw error
  }

  const count = Object.keys(iconSet.export().icons).length
  if (!count) {
    throw new IconctlError(`MasterGo extract-svg returned no icons for file ${source.fileId} layer ${source.layerId}`)
  }

  return {
    type: 'mastergo',
    iconSet,
    notModified: false,
    fileKey: source.fileId,
  }
}
