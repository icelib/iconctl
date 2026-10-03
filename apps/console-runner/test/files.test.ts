import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_ARTIFACT_BYTES } from '@iconctl/console-contracts'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collectFiles,
  extractSvgArchive,
  materializeIconifySource,
  resolveInside,
  validateDirectory,
} from '../src/files'
import { classifyFailure } from '../src/index'

describe('repository Iconify file boundary', () => {
  let root: string
  let repository: string
  let destination: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'iconctl-json-source-'))
    repository = join(root, 'repo')
    destination = join(root, 'materialized.json')
    await mkdir(repository)
    await writeFile(join(repository, 'icons.json'), '{"prefix":"vendor","icons":{}}')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  it('freezes a repository file and permits a symlink whose target stays in the repository', async () => {
    await symlink('icons.json', join(repository, 'linked.json'))
    expect(await materializeIconifySource(repository, 'linked.json', destination)).toBe(destination)
    await writeFile(join(repository, 'icons.json'), 'changed after materialization')
    expect(await readFile(destination, 'utf8')).toBe('{"prefix":"vendor","icons":{}}')
  })
  it.each(['file', 'parent'] as const)('rejects an escaping %s symlink', async (kind) => {
    await writeFile(join(root, 'outside.json'), 'outside')
    await symlink(kind === 'file' ? '../outside.json' : '..', join(repository, 'escape'))
    const failure = await materializeIconifySource(repository, kind === 'file' ? 'escape' : 'escape/outside.json', destination).catch(error => error as Error)
    expect(failure).toHaveProperty('message', 'Iconify JSON source escapes repository')
    expect(classifyFailure(failure)).toBe('configuration')
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects a symlink into Git metadata', async () => {
    await mkdir(join(repository, '.git'))
    await writeFile(join(repository, '.git/config'), 'private metadata')
    await symlink('.git/config', join(repository, 'linked.json'))
    await expect(materializeIconifySource(repository, 'linked.json', destination)).rejects.toThrow('Cannot read repository Iconify JSON source')
  })
  it('rejects directories and missing files as configuration failures', async () => {
    await mkdir(join(repository, 'directory.json'))
    await expect(materializeIconifySource(repository, 'directory.json', destination)).rejects.toThrow('regular file')
    const failure = await materializeIconifySource(repository, 'absent.json', destination).catch(error => error as Error)
    expect(classifyFailure(failure)).toBe('configuration')
  })
  it('rejects oversized files before materializing them', async () => {
    await truncate(join(repository, 'icons.json'), MAX_ARTIFACT_BYTES + 1)
    await expect(materializeIconifySource(repository, 'icons.json', destination)).rejects.toThrow('size limit')
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

it('excludes only the local SVG ownership manifest from collected artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iconctl-artifacts-'))
  try {
    await mkdir(join(root, 'svg'))
    await writeFile(join(root, 'svg/arrow.svg'), '<svg/>')
    await writeFile(join(root, 'svg/.iconctl-manifest.json'), '{"version":1,"files":["arrow.svg"]}')
    await writeFile(join(root, '.iconctl-manifest.json'), 'a different file')
    expect(Object.keys(await collectFiles(root)).sort()).toEqual(['.iconctl-manifest.json', 'svg/arrow.svg'])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

describe('SVG archive boundary', () => {
  it.each([
    '../outside.svg',
    '/outside.svg',
    'a/../../outside.svg',
    'a\\outside.svg',
    '.git/config',
    'script.js',
  ])('rejects unsafe entry %s', async (name) => {
    const root = await mkdtemp(join(tmpdir(), 'iconctl-test-'))
    try {
      await expect(
        extractSvgArchive(zipSync({ [name]: strToU8('<svg/>') }), root),
      ).rejects.toThrow()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('extracts nested SVGs without executing their content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iconctl-test-'))
    try {
      await extractSvgArchive(
        zipSync({ 'arrows/left.svg': strToU8('<svg/>') }),
        root,
      )
      expect(await readFile(join(root, 'arrows/left.svg'), 'utf8')).toBe(
        '<svg/>',
      )
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('rejects inflated files before decompressing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iconctl-test-'))
    try {
      await expect(
        extractSvgArchive(
          zipSync({ 'huge.svg': new Uint8Array(1024 * 1024 + 1) }),
          root,
        ),
      ).rejects.toThrow(/size/)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('rejects symlinks outside the repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iconctl-test-'))
    try {
      await symlink(tmpdir(), join(root, 'icons'))
      await expect(validateDirectory(root, 'icons')).rejects.toThrow(/escapes/)
      expect(() => resolveInside(root, '../secret')).toThrow()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
