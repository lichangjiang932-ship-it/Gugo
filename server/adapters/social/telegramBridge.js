const API_BASE = 'https://api.telegram.org'
const MAX_CHUNK = 3900

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function telegramJson({ token, path, body = null, signal, fetchImpl }) {
  const response = await fetchImpl(`${API_BASE}/bot${token}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.description || `Telegram HTTP ${response.status}`)
  }
  return data
}

async function fileUrl({ token, fileId, fetchImpl, signal }) {
  if (!fileId) return null
  const data = await telegramJson({
    token,
    path: `getFile?file_id=${encodeURIComponent(fileId)}`,
    fetchImpl,
    signal,
  })
  const filePath = data?.result?.file_path
  return filePath ? `${API_BASE}/file/bot${token}/${filePath}` : null
}

async function normalizeUpdate({ token, update, fetchImpl, signal }) {
  const msg = update.message || update.edited_message || update.channel_post || {}
  const chat = msg.chat || {}
  const from = msg.from || msg.sender_chat || {}
  const attachments = []
  const photos = Array.isArray(msg.photo) ? msg.photo : []
  if (photos.length) {
    const best = photos[photos.length - 1]
    attachments.push({
      type: 'image',
      url: await fileUrl({ token, fileId: best.file_id, fetchImpl, signal }),
      platformRef: best.file_id,
      width: best.width,
      height: best.height,
      mimeType: 'image/jpeg',
    })
  }
  if (msg.document) {
    attachments.push({
      type: 'file',
      url: await fileUrl({ token, fileId: msg.document.file_id, fetchImpl, signal }),
      platformRef: msg.document.file_id,
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
    attachments: attachments.filter((item) => item.url || item.platformRef),
    raw: update,
  }
}

export function createTelegramBridgeAdapter({ integration, onMessage, fetchImpl = fetch } = {}) {
  const token = tokenFromIntegration(integration)
  if (!token) throw new Error('Telegram bot token is required')
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
          signal: controller.signal,
        })
        for (const update of data.result || []) {
          offset = Math.max(offset, Number(update.update_id || 0) + 1)
          const message = await normalizeUpdate({ token, update, fetchImpl, signal: controller.signal })
          if (message.chatId && (message.text || message.attachments.length)) onMessage(message)
        }
      } catch {
        if (stopped || controller.signal.aborted) return
        await sleep(3000)
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
        })
      }
    },
  }
}
