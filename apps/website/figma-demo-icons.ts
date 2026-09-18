export const DEMO_PREFIX = 'demo'

export const FIGMA_COMMUNITY_FILE = 'https://www.figma.com/community/file/939851755929765537/Lucide-Icons'

/** Subset of Lucide names used by the website gallery. */
export const DEMO_ICONS = [
  'arrow-left',
  'arrow-right',
  'chevron-down',
  'check',
  'x',
  'user',
  'search',
  'settings',
  'home',
  'menu',
  'plus',
  'minus',
  'trash-2',
  'pencil',
  'mail',
  'bell',
  'calendar',
  'clock',
  'info',
  'circle-alert',
  'heart',
  'star',
  'upload',
  'download',
] as const

export const DEMO_ICON_SET = new Set<string>(DEMO_ICONS)
