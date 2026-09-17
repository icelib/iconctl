export class FigmaIconifyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FigmaIconifyError'
  }
}
