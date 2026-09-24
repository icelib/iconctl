export function fail(
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502 | 503,
  message: string,
): never {
  throw new Error(`ICONCTL_ERROR:${status}:${message}`)
}
export function randomToken(bytes = 32): string {
  return base64(crypto.getRandomValues(new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
export function base64(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) {
    text += String.fromCharCode(byte)
  }
  return btoa(text)
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0))
}
export async function digest(value: string | ArrayBuffer): Promise<string> {
  const data
    = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('')
}
export async function pkce(verifier: string): Promise<string> {
  return base64(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
async function key(secret: string) {
  const bytes = unbase64(secret)
  if (bytes.length !== 32) {
    fail(503, 'Credential encryption key must be 32 random bytes (base64)')
  }
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}
export async function encrypt(
  secret: string,
  context: string,
  value: unknown,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) },
    await key(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  )
  return `v1.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`
}
export async function decrypt<T>(
  secret: string,
  context: string,
  value: string,
): Promise<T> {
  const [version, iv, ciphertext] = value.split('.')
  if (version !== 'v1' || !iv || !ciphertext) {
    fail(503, 'Unsupported encrypted credential format')
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: unbase64(iv),
      additionalData: new TextEncoder().encode(context),
    },
    await key(secret),
    unbase64(ciphertext),
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}
export async function limitedBody(
  request: Request,
  maximum: number,
): Promise<ArrayBuffer> {
  if (Number(request.headers.get('content-length')) > maximum) {
    fail(413, 'Upload is too large')
  }
  const reader = request.body?.getReader()
  if (!reader) {
    return new ArrayBuffer(0)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > maximum) {
      await reader.cancel()
      fail(413, 'Upload is too large')
    }
    chunks.push(value)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output.buffer
}
export async function verifyWebhook(
  secret: string,
  body: ArrayBuffer,
  signature: string | null,
): Promise<boolean> {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
    return false
  }
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, hex =>
    Number.parseInt(hex, 16))
  const imported = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify('HMAC', imported, bytes, body)
}
