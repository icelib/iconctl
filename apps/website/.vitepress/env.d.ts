declare module '*.css'

declare module '*.json' {
  const value: {
    prefix: string
    width?: number
    height?: number
    icons: Record<string, { body: string, width?: number, height?: number }>
  }
  export default value
}
