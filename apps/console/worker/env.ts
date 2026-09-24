// Wrangler generates required platform bindings. Figma is an optional provider:
// the console can serve repository SVG projects before its OAuth App is configured.
export {}
declare global {
  interface Env {
    FIGMA_CLIENT_ID?: string
    FIGMA_CLIENT_SECRET?: string
  }
}
