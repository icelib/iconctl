import type { compareIconSets } from '@iconctl/core'
import { readFile } from 'node:fs/promises'
import { IconctlError } from '@iconctl/core'

type IconifyJSON = Parameters<typeof compareIconSets>[1]

export async function readIcons(file: string): Promise<IconifyJSON> {
  try {
    // compareIconSets performs complete structure and alias validation.
    return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as IconifyJSON
  }
  catch (error) {
    throw new IconctlError(`Cannot read Iconify JSON: ${file}`, { cause: error })
  }
}
