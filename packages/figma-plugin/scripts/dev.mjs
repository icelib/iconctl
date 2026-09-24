import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import process from 'node:process'

let building = false
let pending = false
let timer
let child
function build() {
  if (building) {
    pending = true
    return
  }
  building = true
  child = spawn('pnpm', ['build'], { stdio: 'inherit' })
  child.on('exit', () => {
    building = false
    if (pending) {
      pending = false
      build()
    }
  })
}
const watcher = watch(
  new URL('../src', import.meta.url),
  { recursive: true },
  () => {
    clearTimeout(timer)
    timer = setTimeout(build, 100)
  },
)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    watcher.close()
    child?.kill(signal)
    process.exit()
  })
}
build()
