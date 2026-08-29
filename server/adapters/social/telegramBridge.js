import { fetchSafeOutbound } from '../../utils/outboundNetworkGuard.js'

const API_BASE = 'https://api.telegram.org'
const MAX_CHUNK = 3900
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_API_RESPONSE_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', finish)
      resolve()
    }
    signal?.addEventListener?.('abort', finish, { once: true })
  })
}

function tokenFromIntegration(integration) {
  return integration?.secret?.botToken || integration?.secret?.token || integration?.config?.botToken || ''
}

function clean(value) {
  return String(value ?? '').trim()
}

function pickName(user = {}) {
  return clean(user.first_name || user.username || user.last_name || user.id)
}

function telegramFailure(message, code, {
  statusCode = 502,
  cause,
  upstreamStatus,
  retryable = false,
} = {}) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    retryable,
    ...(cause ? { cause } : {}),
    ...(Number.isInteger(upstreamStatus) ? { upstreamStatus } : {}),
  })
}

function telegramUnavailable(error) {
  return telegramFailure('Telegram bridge service is unavailable', 'TELEGRAM_BRIDGE_UNAVAILABLE', {
    statusCode: 503,
    cause: error,
  })
}

function telegramTimeout(error) {
  return telegramFailure('Telegram bridge request timed out', 'TELEGRAM_BRIDGE_TIMEOUT', {
    statusCode: 504,
    cause: error,
    retryable: true,
  })
}

async function readBoundedBytes(response, maxBytes) {
  const declared = Number(response?.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw telegramFailure('Telegram response exceeds the size limit', 'TELEGRAM_BRIDGE_RESPONSE_TOO_LARGE')
  }
  const reader = response?.body?.getReader?.()
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxBytes) {
      throw telegramFailure('Telegram response exceeds the size limit', 'TELEGRAM_BRIDGE_RESPONSE_TOO_LARGE')
    }
    return bytes
  }
  const chunks = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        try { await reader.cancel() } catch { /* best effort */ }
        throw telegramFailure('Telegram response exceeds the size limit', 'TELEGRAM_BRIDGE_RESPONSE_TOO_LARGE')
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, totalBytes)
  } finally {
    reader.releaseLock?.()
  }
}

async function telegramJsonResponse(response) {
  const bytes = await readBoundedBytes(response, MAX_API_RESPONSE_BYTES)
  let data = null
  try { data = JSON.parse(bytes.toString('utf8')) } catch { /* handled below */ }
  if (!response.ok) {
    throw telegramFailure(
      clean(data?.description) || 'Telegram bridge upstream returned a non-success status',
      'TELEGRAM_BRIDGE_HTTP_ERROR',
      {
        upstreamStatus: response.status,
        retryable: response.status === 429 || response.status >= 500,
      },
    )
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw telegramFailure('Telegram bridge upstream returned invalid JSON', 'TELEGRAM_BRIDGE_RESPONSE_INVALID')
  }
  if (data.ok === false) {
    throw telegramFailure(
      clean(data.description) || 'Telegram bridge API rejected the request',
      'TELEGRAM_BRIDGE_API_ERROR',
    )
  }
  return data
}

async function fetchTelegramOutbound(url, init = {}, {
  fetchImpl = fetch,
  lookup,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  consume = (response) => response,
} = {}) {
  const resolveDns = typeof lookup === 'function' || fetchImpl === globalThis.fetch
  const controller = new AbortController()
  const upstream = init?.signal
  const abortFromUpstream = () => controller.abort(upstream?.reason)
  if (upstream?.aborted) abortFromUpstream()
  else upstream?.addEventListener?.('abort', abortFromUpstream, { once: true })
  let timedOut = false
  let timeoutError = null
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      timeoutError = new Error('Telegram bridge request exceeded its deadline')
      controller.abort(timeoutError)
      reject(timeoutError)
    }, Math.max(1, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS))
  })
  try {
    const request = fetchSafeOutbound(url, { ...init, signal: controller.signal }, {
      fetchImpl,
      allowLocal: false,
      resolveDns,
      ...(typeof lookup === 'function' ? { lookup } : {}),
    }).then(consume)
    return await Promise.race([request, timeout])
  } catch (error) {
    if (timedOut) throw telegramTimeout(timeoutError || error)
    if (String(error?.code || '').startsWith('TELEGRAM_BRIDGE_')) throw error
    throw telegramUnavailable(error)
  } finally {
    clearTimeout(timer)
    upstream?.removeEventListener?.('abort', abortFromUpstream)
  }
}

async function telegramJson({ token, path, body = null, signal, fetchImpl, lookup, timeoutMs }) {
  return fetchTelegramOutbound(`${API_BASE}/bot${token}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  }, {
    fetchImpl,
    lookup,
    timeoutMs,
    consume: telegramJsonResponse,
  })
}

function safeTelegramFilePath(value) {
  const input = clean(value)
  const hasForbiddenCharacter = Array.from(input).some((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f || character === '?' || character === '#'
  })
  if (!input || input.length > 2048 || input.startsWith('/') || input.includes('\\') || hasForbiddenCharacter) {
    return null
  }
  const segments = input.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.map(encodeURIComponent).join('/')
}

async function resolveTelegramFilePath({ token, fileId, fetchImpl, lookup, signal, timeoutMs }) {
  const id = clean(fileId)
  if (!id || id.length > 512) {
    throw telegramFailure('Telegram attachment reference is invalid', 'TELEGRAM_ATTACHMENT_INVALID')
  }
  const data = await telegramJson({
    token,
    path: `getFile?file_id=${encodeURIComponent(id)}`,
    fetchImpl,
    lookup,
    signal,
    timeoutMs,
  })
  const filePath = safeTelegramFilePath(data?.result?.file_path)
  if (!filePath) {
    throw telegramFailure('Telegram attachment path is invalid', 'TELEGRAM_ATTACHMENT_INVALID')
  }
  return filePath
}

function normalizeUpdate(update = {}) {
  const msg = update.message || update.edited_message || update.channel_post || {}
  const chat = msg.chat || {}
  const from = msg.from || msg.sender_chat || {}
  const attachments = []
  const photos = Array.isArray(msg.photo) ? msg.photo : []
  if (photos.length) {
    const best = photos[photos.length - 1]
    attachments.push({
      type: 'image',
      platformRef: clean(best.file_id),
      width: best.width,
      height: best.height,
      mimeType: 'image/jpeg',
      size: best.file_size,
    })
  }
  if (msg.document) {
    attachments.push({
      type: 'file',
      platformRef: clean(msg.document.file_id),
      filename: msg.document.file_name,
      mimeType: msg.document.mime_type,
      size: msg.document.file_size,
    })
  }
  return {
    chatId: clean(chat.id),
    externalUserId: clean(from.id),
    senderName: pickName(from),
    text: clean(msg.text || msg.caption),
    isGroup: clean(chat.type) !== 'private',
    attachments: attachments.filter((item) => item.platformRef),
    raw: update,
  }
}

export function createTelegramBridgeAdapter({
  integration,
  onMessage,
  fetchImpl = fetch,
  lookup,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const token = clean(tokenFromIntegration(integration))
  if (!/^[0-9]+:[A-Za-z0-9_-]+$/u.test(token)) throw new Error('Telegram bot token is required')
  const controller = new AbortController()
  let stopped = false
  let offset = 0
  let loop = null

  async function poll() {
    while (!stopped) {
      try {
        const data = await telegramJson({
          token,
          path: `getUpdates?timeout=25&offset=${offset}`,
          fetchImpl,
          lookup,
          signal: controller.signal,
          timeoutMs: Math.max(timeoutMs, 30_000),
        })
        for (const update of data.result || []) {
          offset = Math.max(offset, Number(update.update_id || 0) + 1)
          const message = normalizeUpdate(update)
          if (message.chatId && (message.text || message.attachments.length)) onMessage(message)
        }
      } catch {
        if (stopped || controller.signal.aborted) return
        await sleep(3000, controller.signal)
      }
    }
  }

  return {
    async start() {
      if (integration?.config?.mode === 'webhook') return
      loop = poll()
    },
    async stop() {
      stopped = true
      controller.abort()
      try { await loop } catch { /* ignore */ }
    },
    async resolveAttachment(attachment = {}) {
      const filePath = await resolveTelegramFilePath({
        token,
        fileId: attachment.platformRef,
        fetchImpl,
        lookup,
        timeoutMs,
      })
      const requestedMime = clean(attachment.mimeType).toLowerCase()
      const result = await fetchTelegramOutbound(`${API_BASE}/file/bot${token}/${filePath}`, {}, {
        fetchImpl,
        lookup,
        timeoutMs,
        consume: async (response) => {
          if (!response.ok) {
            try { await response?.body?.cancel?.() } catch { /* best effort */ }
            throw telegramFailure('Telegram attachment download failed', 'TELEGRAM_BRIDGE_HTTP_ERROR', {
              upstreamStatus: response.status,
              retryable: response.status === 429 || response.status >= 500,
            })
          }
          const responseMime = clean(response.headers?.get?.('content-type')).split(';', 1)[0].toLowerCase()
          const mimeType = responseMime || requestedMime
          if (!mimeType.startsWith('image/')) {
            try { await response?.body?.cancel?.() } catch { /* best effort */ }
            throw telegramFailure('Telegram attachment is not an image', 'TELEGRAM_ATTACHMENT_TYPE_INVALID')
          }
          const bytes = await readBoundedBytes(response, MAX_IMAGE_BYTES)
          return { bytes, mimeType }
        },
      })
      return {
        ...attachment,
        url: `data:${result.mimeType};base64,${result.bytes.toString('base64')}`,
      }
    },
    async sendMessage({ chatId, text }) {
      const chunks = []
      const source = clean(text)
      for (let i = 0; i < source.length; i += MAX_CHUNK) chunks.push(source.slice(i, i + MAX_CHUNK))
      for (const chunk of chunks.length ? chunks : ['']) {
        await telegramJson({
          token,
          path: 'sendMessage',
          body: { chat_id: chatId, text: chunk },
          fetchImpl,
          lookup,
          timeoutMs,
        })
      }
    },
  }
}

export const _telegramInternals = Object.freeze({ normalizeUpdate, safeTelegramFilePath })
