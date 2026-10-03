import { saveBlobDownload } from './features/review/snapshot-download'

export function downloadBlob(blob: Blob, filename: string) {
  saveBlobDownload(blob, filename, {
    createObjectURL: value => URL.createObjectURL(value),
    revokeObjectURL: value => URL.revokeObjectURL(value),
    createLink(url, name) {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      return {
        append: () => document.body.append(anchor),
        click: () => anchor.click(),
        remove: () => anchor.remove(),
      }
    },
  })
}
