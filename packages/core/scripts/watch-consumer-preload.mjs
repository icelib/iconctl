import fs from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import process from 'node:process'

const original = fs.promises.readdir
let injected = false
fs.promises.readdir = async (...args) => {
  if (!injected && String(args[0]) === process.env.ICONCTL_TEST_RACE_ROOT && args[1]?.encoding === 'utf8' && args[1]?.withFileTypes === false) {
    injected = true
    await rm(args[0], { recursive: true })
    await writeFile(args[0], 'replaced directory')
    try {
      return await original(...args)
    }
    catch (error) {
      if (error.code === 'ENOTDIR') {
        process.send?.('ENOTDIR')
      }
      throw error
    }
  }
  return original(...args)
}
syncBuiltinESMExports()
