import process from 'node:process'
import { defaultIconNameForNode, defineConfig } from '@iconctl/core'
import { DEMO_ICON_SET, DEMO_PREFIX, FIGMA_COMMUNITY_FILE } from './figma-demo-icons'

export default defineConfig({
  prefix: DEMO_PREFIX,
  sources: [
    {
      type: 'figma',
      // Community URLs are rejected until you duplicate the file and set ICONCTL_FIGMA_FILE
      // to the resulting https://www.figma.com/design/{fileKey}/... URL.
      file: process.env.ICONCTL_FIGMA_FILE ?? FIGMA_COMMUNITY_FILE,
      iconNameForNode: (node) => {
        const name = defaultIconNameForNode(node)
        return name && DEMO_ICON_SET.has(name) ? name : null
      },
    },
  ],
  output: {
    json: '.vitepress/theme/data/figma-demo.json',
  },
  validate: {
    width: 24,
    height: 24,
  },
})
