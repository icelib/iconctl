import { expectType } from 'tsd'
import { defineConfig, parseFigmaFileKey } from '..'

expectType<string>(parseFigmaFileKey('AbCdEfGhIjKlMnOpQrStUv'))
expectType<{ prefix: string, sources: [{ type: 'figma', file: string }] }>(defineConfig({
  prefix: 'brand',
  sources: [{ type: 'figma', file: 'AbCdEfGhIjKlMnOpQrStUv' }],
}))
