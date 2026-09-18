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

export type SourceConfig = FigmaSourceConfig | DirectorySourceConfig

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

export type ResolvedSourceConfig = ResolvedFigmaSourceConfig | ResolvedDirectorySourceConfig

export interface LoadedSource {
  type: SourceConfig['type']
  iconSet?: IconSet
  notModified: boolean
  fileKey?: string
  fileVersion?: string
  lastModified?: string
}
