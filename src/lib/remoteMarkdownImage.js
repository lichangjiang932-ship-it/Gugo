import { getAuthToken } from './accountClient.js'

export function remoteMarkdownImageUrl(value, origin = globalThis.window?.location?.origin) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const source = value.trim()
    const base = origin || 'https://markdown.invalid'
    const url = new URL(source, base)
    const external = origin ? url.origin !== new URL(origin).origin
      : /^[a-z][a-z\d+.-]*:/iu.test(source) || /^[\\/]{2}/u.test(source)
    return ['http:', 'https:'].includes(url.protocol) && external ? url.href : null
  } catch {
    return null
  }
}

export async function loadRemoteMarkdownImage(url, {
  signal,
  fetchImpl = globalThis.fetch,
  authToken = getAuthToken(),
} = {}) {
  const response = await fetchImpl('/api/media/remote-image', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
    body: JSON.stringify({ url }),
    signal,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw Object.assign(new Error(payload?.error?.message || 'Unable to load image'), {
      code: payload?.error?.code || 'REMOTE_IMAGE_FAILED',
    })
  }
  const blob = await response.blob()
  if (!/^image\/(?:png|jpeg|gif|webp|avif)$/u.test(blob.type)) throw new Error('Invalid image response')
  return blob
}
