import { expectType } from 'tsd'
import { toIconName } from '..'

expectType<string>(toIconName('Arrow Left'))
