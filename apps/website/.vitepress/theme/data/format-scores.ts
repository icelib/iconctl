export const FORMAT_IDS = [
  'mask',
  'inline',
  'runtime',
  'file',
  'background',
  'symbol',
  'webfont',
] as const

export type FormatId = typeof FORMAT_IDS[number]

export type FormatBadge = 'mainstream' | 'situational' | 'legacy'

export const formatBadge: Record<FormatId, FormatBadge> = {
  mask: 'mainstream',
  inline: 'mainstream',
  runtime: 'mainstream',
  file: 'situational',
  background: 'situational',
  symbol: 'legacy',
  webfont: 'legacy',
}

export const SCORE_IDS = [
  'theme',
  'multicolor',
  'treeshake',
  'requests',
  'alignment',
  'a11y',
  'miniprogram',
  'animation',
  'dx',
  'fit',
] as const

export type ScoreId = typeof SCORE_IDS[number]

export const formatScores: Record<ScoreId, Record<FormatId, number>> = {
  theme: { inline: 5, file: 1, symbol: 5, mask: 5, background: 1, runtime: 5, webfont: 5 },
  multicolor: { inline: 5, file: 5, symbol: 2, mask: 1, background: 5, runtime: 5, webfont: 1 },
  treeshake: { inline: 4, file: 4, symbol: 2, mask: 5, background: 5, runtime: 4, webfont: 1 },
  requests: { inline: 5, file: 2, symbol: 3, mask: 5, background: 4, runtime: 3, webfont: 2 },
  alignment: { inline: 5, file: 5, symbol: 4, mask: 5, background: 5, runtime: 5, webfont: 2 },
  a11y: { inline: 5, file: 3, symbol: 3, mask: 3, background: 3, runtime: 5, webfont: 1 },
  miniprogram: { inline: 1, file: 2, symbol: 1, mask: 5, background: 3, runtime: 1, webfont: 2 },
  animation: { inline: 5, file: 1, symbol: 3, mask: 2, background: 1, runtime: 5, webfont: 2 },
  dx: { inline: 2, file: 2, symbol: 3, mask: 5, background: 5, runtime: 4, webfont: 5 },
  fit: { inline: 3, file: 2, symbol: 2, mask: 5, background: 2, runtime: 3, webfont: 1 },
}

export const COMPARE_ICONS = ['arrow-left', 'heart', 'star', 'user'] as const

/** Fantasticon PUA: user=0xF101, star=0xF102, heart=0xF103, arrow-left=0xF104 */
export const WEBFONT_CODEPOINTS: Record<string, string> = {
  'user': '\uF101',
  'star': '\uF102',
  'heart': '\uF103',
  'arrow-left': '\uF104',
}
