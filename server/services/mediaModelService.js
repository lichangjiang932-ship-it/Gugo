import { listModelProviders } from './modelProviderStore.js'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

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

async function responseError(response) {
  const text = await response.text()
  try { return JSON.parse(text)?.error?.message || `HTTP ${response.status}` } catch { return text.slice(0, 500) || `HTTP ${response.status}` }
}

export async function generateImage({ userId, providerKey, model, prompt, size = '1024x1024', fetchImpl = fetch } = {}) {
  const provider = providerConfig(userId, providerKey)
  const response = await fetchImpl(endpoint(provider.baseUrl, '/images/generations'), {
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
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json()
  const item = payload?.data?.[0]
  let buffer
  if (item?.b64_json) buffer = Buffer.from(item.b64_json, 'base64')
  else if (item?.url) {
    const download = await fetchImpl(item.url, { signal: AbortSignal.timeout(60_000) })
    if (!download.ok) throw new Error(`image download failed: HTTP ${download.status}`)
    buffer = Buffer.from(await download.arrayBuffer())
  }
  if (!buffer?.length) throw new Error('图像服务没有返回图片')
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('生成图片超过 20MB 限制')
  return { buffer, mimeType: 'image/png', revisedPrompt: item?.revised_prompt || null, provider: provider.key }
}

export async function transcribeAudio({ userId, providerKey, model = 'whisper-1', audio, mimeType = 'audio/webm', language, fetchImpl = fetch } = {}) {
  const provider = providerConfig(userId, providerKey)
  const buffer = Buffer.from(audio || [])
  if (!buffer.length) throw Object.assign(new Error('音频不能为空'), { statusCode: 400 })
  if (buffer.length > MAX_AUDIO_BYTES) throw Object.assign(new Error('音频超过 25MB 限制'), { statusCode: 413 })
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimeType }), `speech.${mimeType.includes('ogg') ? 'ogg' : 'webm'}`)
  form.append('model', model)
  if (language) form.append('language', language)
  const response = await fetchImpl(endpoint(provider.baseUrl, '/audio/transcriptions'), {
    method: 'POST',
    headers: headers(provider),
    body: form,
    signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json()
  return { text: String(payload?.text || ''), provider: provider.key }
}
