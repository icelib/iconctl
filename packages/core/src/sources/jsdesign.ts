import type { LoadedSource, ResolvedJsdesignSourceConfig } from './types'
import { IconctlError } from '../errors'
import { loadDirectorySource } from './directory'

export const JSDESIGN_REMOTE_HELP = '即时设计没有可供 CLI/CI 使用的稳定公开 REST。官方能力是插件 API；社区 MCP 需要本机插件和 WebSocket。请在即时设计里批量导出 SVG，然后使用 `{ type: "jsdesign", dir: "./exported-svg" }` 或 `{ type: "directory", dir: "./exported-svg" }`。'

export async function loadJsdesignSource(
  source: ResolvedJsdesignSourceConfig,
  options: { cwd: string, prefix: string },
): Promise<LoadedSource> {
  if (source.dir) {
    const loaded = await loadDirectorySource({ type: 'directory', dir: source.dir }, options)
    return { ...loaded, type: 'jsdesign' }
  }

  throw new IconctlError(JSDESIGN_REMOTE_HELP)
}
