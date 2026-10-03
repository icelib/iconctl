import { expect, it, vi } from 'vitest'
import { readZipResponse } from '../src/api-response'

it('reads binary ZIP responses without JSON conversion', async () => {
  const response = new Response('PK bytes', { headers: { 'Content-Type': 'application/zip' } })
  const blob = await readZipResponse(response, new AbortController().signal)
  expect(await blob.text()).toBe('PK bytes')
})
it('does not download JSON or HTML as a successful ZIP', async () => {
  await expect(readZipResponse(Response.json({ ok: true }), new AbortController().signal)).rejects.toMatchObject({ status: 200, message: '服务器响应格式无效，请重试' })
})
it('uses existing structured HTTP and authentication errors', async () => {
  await expect(readZipResponse(Response.json({ error: 'Too large' }, { status: 413 }), new AbortController().signal)).rejects.toMatchObject({ status: 413, message: 'Too large' })
  await expect(readZipResponse(Response.json({}, { status: 401 }), new AbortController().signal)).rejects.toMatchObject({ status: 401 })
})
it('checks cancellation before reading a stale response or returning a buffered blob', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(readZipResponse(Response.json({}, { status: 401 }), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  const second = new AbortController()
  const response = new Response('zip', { headers: { 'Content-Type': 'application/zip' } })
  vi.spyOn(response, 'blob').mockImplementation(async () => {
    second.abort()
    return new Blob(['zip'])
  })
  await expect(readZipResponse(response, second.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
