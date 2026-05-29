import crypto from 'node:crypto'

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const LONG_POLL_MS = 40_000
const MESSAGE_TYPE_BOT = 2
const MESSAGE_STATE_FINISH = 2
const ITEM_TEXT = 1
const ITEM_IMAGE = 2

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clean(value) {
  return String(value ?? '').trim()
}

function botToken(integration) {
  return clean(integration?.secret?.botToken || integration?.secret?.token || integration?.config?.botToken)
}

function headers(token) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
  }
}

function extractText(items = []) {
  for (const item of items) {
    if (item?.type === ITEM_TEXT && item.text_item?.text != null) return clean(item.text_item.text)
    if (item?.voice_item?.text) return clean(item.voice_item.text)
  }
  return ''
}

function normalizeInbound(msg = {}) {
  const from = clean(msg.from_user_id)
  const attachments = []
  for (const item of msg.item_list || []) {
    if (item?.type === ITEM_IMAGE && item.image_item?.media?.encrypt_query_param) {
      attachments.push({
        type: 'image',
        platformRef: JSON.stringify(item.image_item.media),
        mimeType: 'image/jpeg',
      })
    }
  }
  return {
    chatId: from,
    externalUserId: from,
    senderName: from.split('@')[0] || from,
    text: extractText(msg.item_list),
    isGroup: false,
    attachments,
    raw: msg,
  }
}

export function createWechatIlinkBridgeAdapter({ integration, onMessage, fetchImpl = fetch } = {}) {
  const token = botToken(integration)
  if (!token) throw new Error('WeChat bot token is required')
  const baseUrl = clean(integration?.config?.baseUrl) || DEFAULT_BASE_URL
  const controller = new AbortController()
  let stopped = false
  let loop = null
  let updateBuffer = clean(integration?.config?.getUpdatesBuf)
  const contextTokens = new Map()

  async function api(path, body, timeoutMs = 15_000) {
    const child = new AbortController()
    const timer = setTimeout(() => child.abort(), timeoutMs)
    const onAbort = () => child.abort()
    controller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify(body),
        signal: child.signal,
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || (data?.ret != null && data.ret !== 0)) {
        throw new Error(data?.errmsg || data?.message || `WeChat HTTP ${response.status}`)
      }
      return data || {}
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
    }
  }

  async function poll() {
    while (!stopped) {
      try {
        const data = await api('ilink/bot/getupdates', {
          get_updates_buf: updateBuffer,
          base_info: { channel_version: '1.0.0' },
        }, LONG_POLL_MS)
        if (data.get_updates_buf) updateBuffer = data.get_updates_buf
        for (const msg of data.msgs || []) {
          const inbound = normalizeInbound(msg)
          if (!inbound.chatId || inbound.chatId.endsWith('@im.bot')) continue
          if (msg.context_token) contextTokens.set(inbound.chatId, msg.context_token)
          if (inbound.text || inbound.attachments.length) onMessage(inbound)
        }
      } catch {
        if (stopped || controller.signal.aborted) return
        await sleep(3000)
      }
    }
  }

  async function sendText(chatId, text) {
    const contextToken = contextTokens.get(chatId)
    if (!contextToken) throw new Error('WeChat requires a recent inbound message context before replying')
    await api('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: chatId,
        client_id: crypto.randomUUID(),
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        item_list: [{ type: ITEM_TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: '1.0.0' },
    })
  }

  return {
    async start() {
      loop = poll()
    },
    async stop() {
      stopped = true
      controller.abort()
      try { await loop } catch { /* ignore */ }
    },
    async sendMessage({ chatId, text }) {
      const source = clean(text)
      for (let i = 0; i < source.length; i += 3900) {
        await sendText(chatId, source.slice(i, i + 3900))
      }
    },
  }
}

export async function getWechatIlinkQrcode({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    headers: { 'iLink-App-ClientVersion': '1' },
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.qrcode) throw new Error(data?.errmsg || `WeChat QR HTTP ${response.status}`)
  return {
    qrcodeId: data.qrcode,
    qrcodeText: data.qrcode_img_content || data.qrcode,
  }
}

export async function pollWechatIlinkQrcode({ qrcodeId, fetchImpl = fetch } = {}) {
  if (!qrcodeId) throw new Error('qrcodeId is required')
  const response = await fetchImpl(`${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`, {
    headers: { 'iLink-App-ClientVersion': '1' },
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.errmsg || `WeChat QR HTTP ${response.status}`)
  if (data.status === 'confirmed') {
    return {
      status: 'confirmed',
      botToken: data.bot_token,
      botId: data.ilink_bot_id,
      userId: data.ilink_user_id,
      baseUrl: data.baseurl,
    }
  }
  if (data.status === 'scaned') return { status: 'scanned' }
  if (data.status === 'expired') return { status: 'expired' }
  return { status: 'waiting' }
}
