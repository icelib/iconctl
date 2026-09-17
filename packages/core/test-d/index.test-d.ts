import { expectType } from 'tsd'
import { defineConfig, parseFigmaFileKey } from '..'

expectType<string>(parseFigmaFileKey('AbCdEfGhIjKlMnOpQrStUv'))
expectType<{ file: string, prefix: string }>(defineConfig({
  file: 'AbCdEfGhIjKlMnOpQrStUv',
  prefix: 'brand',
}))
