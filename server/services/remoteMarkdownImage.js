import sharp from 'sharp'
import { fetchSafeOutbound, isPureLocalModeEnabled } from '../utils/outboundNetworkGuard.js'

export const MAX_REMOTE_MARKDOWN_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_PIXELS = 20_000_000
const MIME_BY_FORMAT = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' }
const MIME_TYPES = new Set(Object.values(MIME_BY_FORMAT))

function imageError(code, message, statusCode = 422) {
  return Object.assign(new Error(message), { code, statusCode, retryable: false })
}

async function readImageBody(response) {
  if (Number(response.headers.get('content-length')) > MAX_REMOTE_MARKDOWN_IMAGE_BYTES) {
    await response.body?.cancel()
    throw imageError('REMOTE_IMAGE_TOO_LARGE', 'Remote image exceeds the size limit', 413)
  }
  if (!response.body) throw imageError('REMOTE_IMAGE_EMPTY', 'Remote image response is empty')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_REMOTE_MARKDOWN_IMAGE_BYTES) {
        throw imageError('REMOTE_IMAGE_TOO_LARGE', 'Remote image exceeds the size limit', 413)
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks, size)
  } catch (error) {
    try { await reader.cancel() } catch { /* preserve the bounded-read failure */ }
    throw error
  } finally {
    reader.releaseLock()
  }
}

export async function fetchRemoteMarkdownImage(url, {
  env = process.env,
  signal,
  fetchImpl = globalThis.fetch,
  lookup,
} = {}) {
  // This endpoint serves external images only. Reject before DNS as well as
  // before HTTP when the authoritative runtime policy is local-only.
  if (isPureLocalModeEnabled(env) || isPureLocalModeEnabled()) {
    throw imageError('OUTBOUND_PURE_LOCAL_DENIED', 'Remote images are disabled by pure-local mode', 403)
  }
  if (typeof url !== 'string' || !url.trim() || url.length > 4096) {
    throw imageError('REMOTE_IMAGE_URL_INVALID', 'A bounded remote image URL is required', 400)
  }
  const timeout = AbortSignal.timeout(15_000)
  const response = await fetchSafeOutbound(url, {
    headers: { Accept: [...MIME_TYPES].join(', ') },
    credentials: 'omit',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }, { fetchImpl, lookup, allowCrossOriginRedirects: true })
  if (!response.ok) {
    await response.body?.cancel()
    throw imageError('REMOTE_IMAGE_FETCH_FAILED', 'Remote image request failed', 502)
  }
  const declaredType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!MIME_TYPES.has(declaredType)) {
    await response.body?.cancel()
    throw imageError('REMOTE_IMAGE_TYPE_UNSUPPORTED', 'Only raster image responses are supported', 415)
  }
  const buffer = await readImageBody(response)
  let metadata
  try { metadata = await sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata() }
  catch { throw imageError('REMOTE_IMAGE_INVALID', 'Remote response is not a supported image') }
  const format = metadata.format === 'heif' && metadata.compression === 'av1' ? 'avif' : metadata.format
  const mimeType = MIME_BY_FORMAT[format]
  if (!mimeType || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
    throw imageError('REMOTE_IMAGE_INVALID', 'Remote image exceeds the supported format or pixel limits')
  }
  return { buffer, mimeType }
}
