import { listModelProviders } from './modelProviderStore.js'
import { isLocalEndpoint } from '../utils/endpointProfile.js'
import { fetchSafeOutbound } from '../utils/outboundNetworkGuard.js'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const MAX_IMAGE_JSON_BYTES = 30 * 1024 * 1024
const MAX_MEDIA_JSON_BYTES = 2 * 1024 * 1024

function providerConfig(userId, providerKey) {
  const providers = listModelProviders({ userId, includeSecrets: true }).filter((item) => item.enabled)
  const provider = providerKey
    ? providers.find((item) => item.key === providerKey || item.id === providerKey)
    : providers.find((item) => item.isDefault) || providers[0]
  if (!provider) throw Object.assign(new Error('请先配置一个支持媒体 API 的模型服务'), { statusCode: 409 })
  return provider
}

function endpoint(baseUrl, suffix) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|responses)$/i, '')
  return `${base}${suffix}`
}

function headers(provider, extra = {}) {
  return {
    ...provider.headers,
    ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    ...extra,
  }
}

function fetchMediaOutbound(url, init, {
  fetchImpl,
  lookup,
  allowLocal = false,
  allowCrossOriginRedirects = false,
}) {
  // Keep explicit test transports hermetic; production and injected lookups
  // still validate DNS and pin the approved address through the central guard.
  const shouldResolveDns = typeof lookup === 'function' || fetchImpl === globalThis.fetch
  return fetchSafeOutbound(url, init, {
    fetchImpl,
    resolveDns: shouldResolveDns,
    allowLocal,
    allowCrossOriginRedirects,
    ...(typeof lookup === 'function' ? { lookup } : {}),
  })
}

function responseTooLarge(maxBytes) {
  const error = new Error(`Media response exceeds the ${maxBytes} byte limit`)
  error.code = 'MEDIA_RESPONSE_TOO_LARGE'
  error.statusCode = 502
  error.retryable = false
  return error
}

async function readBoundedResponseBuffer(response, maxBytes) {
  const contentLength = response?.headers?.get?.('content-length')
  const declaredBytes = contentLength == null || contentLength === ''
    ? null
    : Number(contentLength)
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    try { await response?.body?.cancel?.() } catch { /* best effort */ }
    throw responseTooLarge(maxBytes)
  }

  if (!response?.body?.getReader) {
    const bytes = typeof response?.arrayBuffer === 'function'
      ? Buffer.from(await response.arrayBuffer())
      : Buffer.from(await response.text())
    if (bytes.length > maxBytes) throw responseTooLarge(maxBytes)
    return bytes
  }

  const reader = response.body.getReader()
  const chunks = []
  let totalBytes = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value || [])
    totalBytes += chunk.length
    if (totalBytes > maxBytes) {
      try { await reader.cancel() } catch { /* best effort */ }
      throw responseTooLarge(maxBytes)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, totalBytes)
}

async function readBoundedResponseJson(response, maxBytes) {
  const text = (await readBoundedResponseBuffer(response, maxBytes)).toString('utf8')
  return JSON.parse(text)
}

async function responseError(response) {
  const text = (await readBoundedResponseBuffer(response, MAX_MEDIA_JSON_BYTES)).toString('utf8')
  try { return JSON.parse(text)?.error?.message || `HTTP ${response.status}` } catch { return text.slice(0, 500) || `HTTP ${response.status}` }
}

function detectImageMime(buffer, hintedType = '') {
  const hint = String(hintedType || '').split(';', 1)[0].trim().toLowerCase()
  if (buffer?.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer?.[0] === 0xff && buffer?.[1] === 0xd8 && buffer?.[2] === 0xff) return 'image/jpeg'
  if (buffer?.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif'
  if (buffer?.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer?.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  const brand = buffer?.subarray(4, 12).toString('ascii') || ''
  if (brand.startsWith('ftypavif') || brand.startsWith('ftypavis')) return 'image/avif'
  if (/^image\/(?:png|jpe?g|gif|webp|avif)$/u.test(hint)) {
    return hint === 'image/jpg' ? 'image/jpeg' : hint
  }
  return 'image/png'
}

export async function generateImage({
  userId,
  providerKey,
  model,
  prompt,
  size = '1024x1024',
  fetchImpl = globalThis.fetch,
  lookup,
} = {}) {
  const provider = providerConfig(userId, providerKey)
  const providerOutbound = {
    fetchImpl,
    lookup,
    allowLocal: isLocalEndpoint(provider.baseUrl),
  }
  const response = await fetchMediaOutbound(endpoint(provider.baseUrl, '/images/generations'), {
    method: 'POST',
    headers: headers(provider, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model: String(model || provider.defaultModel),
      prompt: String(prompt || '').trim(),
      size,
      n: 1,
      response_format: 'b64_json',
    }),
    signal: AbortSignal.timeout(180_000),
  }, providerOutbound)
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await readBoundedResponseJson(response, MAX_IMAGE_JSON_BYTES)
  const item = payload?.data?.[0]
  let buffer
  let hintedMimeType = item?.mime_type || item?.mimeType || ''
  if (item?.b64_json) {
    const encodedImage = String(item.b64_json)
    if (Buffer.byteLength(encodedImage, 'base64') > MAX_IMAGE_BYTES) {
      throw responseTooLarge(MAX_IMAGE_BYTES)
    }
    buffer = Buffer.from(encodedImage, 'base64')
  }
  else if (item?.url) {
    const download = await fetchMediaOutbound(
      item.url,
      { signal: AbortSignal.timeout(60_000) },
      { fetchImpl, lookup, allowCrossOriginRedirects: true },
    )
    if (!download.ok) throw new Error(`image download failed: HTTP ${download.status}`)
    hintedMimeType = download.headers.get('content-type') || hintedMimeType
    buffer = await readBoundedResponseBuffer(download, MAX_IMAGE_BYTES)
  }
  if (!buffer?.length) throw new Error('图像服务没有返回图片')
  if (buffer.length > MAX_IMAGE_BYTES) throw responseTooLarge(MAX_IMAGE_BYTES)
  return {
    buffer,
    mimeType: detectImageMime(buffer, hintedMimeType),
    revisedPrompt: item?.revised_prompt || null,
    provider: provider.key,
  }
}

export async function transcribeAudio({
  userId,
  providerKey,
  model = 'whisper-1',
  audio,
  mimeType = 'audio/webm',
  language,
  fetchImpl = globalThis.fetch,
  lookup,
} = {}) {
  const provider = providerConfig(userId, providerKey)
  const buffer = Buffer.from(audio || [])
  if (!buffer.length) throw Object.assign(new Error('音频不能为空'), { statusCode: 400 })
  if (buffer.length > MAX_AUDIO_BYTES) throw Object.assign(new Error('音频超过 25MB 限制'), { statusCode: 413 })
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimeType }), `speech.${mimeType.includes('ogg') ? 'ogg' : 'webm'}`)
  form.append('model', model)
  if (language) form.append('language', language)
  const response = await fetchMediaOutbound(endpoint(provider.baseUrl, '/audio/transcriptions'), {
    method: 'POST',
    headers: headers(provider),
    body: form,
    signal: AbortSignal.timeout(180_000),
  }, { fetchImpl, lookup, allowLocal: isLocalEndpoint(provider.baseUrl) })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await readBoundedResponseJson(response, MAX_MEDIA_JSON_BYTES)
  return { text: String(payload?.text || ''), provider: provider.key }
}
