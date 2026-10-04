import type { compareIconSets } from '@iconctl/core'
import { isUtf8 } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { IconctlError } from '@iconctl/core'

type IconifyJSON = Parameters<typeof compareIconSets>[1]

export function localIconPath(value: unknown, option: string): string {
  if (typeof value !== 'string' || !value.trim() || value === '-' || /^[a-z][\w+.-]*:\/\//i.test(value.trim())) {
    throw new IconctlError(`--${option} must be a local file path; URLs and stdin/stdout are not supported.`)
  }
  return resolve(value)
}

export async function readIcons(file: string): Promise<IconifyJSON> {
  try {
    // Core consumers perform complete structure and alias validation.
    const bytes = await readFile(file)
    if (!isUtf8(bytes)) {
      throw new Error('Invalid UTF-8 input')
    }
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as IconifyJSON
  }
  catch (error) {
    throw new IconctlError(`Cannot read Iconify JSON: ${file}`, { cause: error })
  }
}
