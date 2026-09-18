import type { IconSet } from '@iconify/tools'
import type { FigmaImportNodeFilter } from '@iconify/tools/lib/import/figma/types/nodes'

export interface FigmaSourceConfig {
  type: 'figma'
  file: string
  pages?: string[]
  depth?: number
  ids?: string[]
  token?: string
  iconNameForNode?: FigmaImportNodeFilter
}

export interface DirectorySourceConfig {
  type: 'directory'
  dir: string
}

export interface MastergoSourceConfig {
  type: 'mastergo'
  file?: string
  fileId?: string
  layerId?: string
  token?: string
  baseUrl?: string
}

export interface JsdesignSourceConfig {
  type: 'jsdesign'
  file?: string
  dir?: string
  token?: string
}

export interface IconfontSourceConfig {
  type: 'iconfont'
  url?: string
  dir?: string
  stripPrefix?: string
}

export type SourceConfig
  = | FigmaSourceConfig
    | DirectorySourceConfig
    | MastergoSourceConfig
    | JsdesignSourceConfig
    | IconfontSourceConfig

export interface ResolvedFigmaSourceConfig {
  type: 'figma'
  file: string
  pages?: string[]
  depth: number
  ids?: string[]
  token?: string
  iconNameForNode?: FigmaImportNodeFilter
}

export interface ResolvedDirectorySourceConfig {
  type: 'directory'
  dir: string
}

export interface ResolvedMastergoSourceConfig {
  type: 'mastergo'
  fileId: string
  layerId: string
  token?: string
  baseUrl: string
}

export interface ResolvedJsdesignSourceConfig {
  type: 'jsdesign'
  file?: string
  dir?: string
  token?: string
}

export interface ResolvedIconfontSourceConfig {
  type: 'iconfont'
  url?: string
  dir?: string
  stripPrefix: string
}

export type ResolvedSourceConfig
  = | ResolvedFigmaSourceConfig
    | ResolvedDirectorySourceConfig
    | ResolvedMastergoSourceConfig
    | ResolvedJsdesignSourceConfig
    | ResolvedIconfontSourceConfig

export interface LoadedSource {
  type: SourceConfig['type']
  iconSet?: IconSet
  notModified: boolean
  fileKey?: string
  fileVersion?: string
  lastModified?: string
}
