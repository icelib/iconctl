import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  extractSvgArchive,
  resolveInside,
  validateDirectory,
} from '../src/files'

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
