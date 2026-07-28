import QRCode from 'qrcode'
import { readJson, sendJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import { socialBridgeManager } from '../services/socialBridgeManager.js'
import { getIntegrationCredentialsById, upsertIntegration } from '../services/integrationsStore.js'
import { getWechatIlinkQrcode, pollWechatIlinkQrcode } from '../adapters/social/wechatIlinkBridge.js'

function clean(value) {
  return String(value ?? '').trim()
}

function pickName(user = {}) {
  return clean(user.name || user.nickname || user.first_name || user.username || user.open_id || user.id)
}

function normalizeTelegram(body, integrationId) {
  const msg = body.message || body.edited_message || body.channel_post || {}
  const chat = msg.chat || {}
  const from = msg.from || msg.sender_chat || {}
  const photos = Array.isArray(msg.photo) ? msg.photo : []
  const attachments = []
  if (photos.length) {
    const best = photos[photos.length - 1]
    attachments.push({
      type: 'image',
      platformRef: best.file_id,
      width: best.width,
      height: best.height,
    })
  }
  if (msg.document) {
    attachments.push({
      type: 'file',
      platformRef: msg.document.file_id,
      filename: msg.document.file_name,
      mimeType: msg.document.mime_type,
      size: msg.document.file_size,
    })
  }
  return {
    integrationId,
    provider: 'telegram',
    chatId: clean(chat.id),
    externalUserId: clean(from.id),
    senderName: pickName(from),
    text: clean(msg.text || msg.caption),
    isGroup: clean(chat.type) !== 'private',
    attachments,
    raw: body,
  }
}

function parseJsonText(value, fallback = {}) {
  if (!value || typeof value !== 'string') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function normalizeFeishu(body, integrationId) {
  const event = body.event || {}
  const message = event.message || body.message || {}
  const sender = event.sender?.sender_id || event.sender || {}
  const content = typeof message.content === 'string' ? parseJsonText(message.content) : (message.content || {})
  const msgType = message.message_type || message.msg_type
  const text = content.text || content.title || content.content || ''
  const attachments = []
  if (msgType === 'image' && content.image_key) {
    attachments.push({ type: 'image', platformRef: content.image_key, mimeType: 'image/jpeg' })
  }
  if (msgType === 'file' && content.file_key) {
    attachments.push({ type: 'file', platformRef: content.file_key, filename: content.file_name })
  }
  return {
    integrationId,
    provider: 'feishu',
    chatId: clean(message.chat_id || message.chatId || event.open_chat_id),
    externalUserId: clean(sender.open_id || sender.user_id || sender.union_id || sender.id),
    senderName: clean(event.sender?.sender_type || sender.name || sender.open_id || 'Feishu user'),
    text: clean(text),
    isGroup: clean(message.chat_type || message.chatType) !== 'p2p',
    messageId: message.message_id,
    attachments,
    raw: body,
  }
}

function normalizeQQ(body, integrationId) {
  const data = body.d || body.data || body
  const author = data.author || data.member || {}
  const groupId = data.group_openid || data.group_id || data.guild_id || data.channel_id
  const userId = data.author?.id || data.user_openid || data.openid || data.user_id
  return {
    integrationId,
    provider: 'qq',
    chatId: clean(groupId || userId),
    externalUserId: clean(userId),
    senderName: pickName(author),
    text: clean(data.content || data.text || data.message),
    isGroup: !!groupId,
    messageId: data.id || data.msg_id,
    attachments: [],
    raw: body,
  }
}

function normalizeWechat(body, integrationId) {
  const data = body.data || body
  const chatId = data.chatId || data.chat_id || data.conversation_id || data.from_user || data.fromUser
  const userId = data.userId || data.user_id || data.from_user || data.fromUser
  const attachments = []
  if (data.imageUrl || data.image_url) {
    attachments.push({ type: 'image', url: data.imageUrl || data.image_url })
  }
  return {
    integrationId,
    provider: 'wechat_personal',
    chatId: clean(chatId),
    externalUserId: clean(userId),
    senderName: clean(data.senderName || data.sender_name || data.nickname || userId),
    text: clean(data.text || data.content || data.message),
    isGroup: !!(data.isGroup || data.is_group),
    attachments,
    raw: body,
  }
}

function normalizeWebhook(provider, body, integrationId) {
  if (provider === 'telegram') return normalizeTelegram(body, integrationId)
  if (provider === 'feishu') return normalizeFeishu(body, integrationId)
  if (provider === 'qq') return normalizeQQ(body, integrationId)
  if (provider === 'wechat' || provider === 'wechat_personal') return normalizeWechat(body, integrationId)
  return {
    integrationId,
    provider,
    chatId: clean(body.chatId || body.chat_id || body.from || body.userId),
    externalUserId: clean(body.userId || body.user_id || body.from),
    senderName: clean(body.senderName || body.name || body.userName),
    text: clean(body.text || body.content || body.message),
    isGroup: !!body.isGroup,
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
    raw: body,
  }
}

function unauthorized(res) {
  return sendJson(res, 401, { ok: false, error: 'Unauthorized' })
}

export function createBridgeRequestHandler({
  manager = socialBridgeManager,
  authenticate = authenticateRequest,
  getWechatQrcode = getWechatIlinkQrcode,
  pollWechatQrcode = pollWechatIlinkQrcode,
} = {}) {
  return async function handleBridgeRequest(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)

    try {
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'bridge' && parts[2] === 'webhook') {
        const provider = clean(parts[3])
        const integrationId = decodeURIComponent(parts[4] || '')
        const body = await readJson(req, { maxBytes: 8 * 1024 * 1024 })
        if (provider === 'feishu' && body.challenge) {
          return sendJson(res, 200, { challenge: body.challenge })
        }
        const message = normalizeWebhook(provider, body, integrationId)
        if (!message.chatId) return sendJson(res, 400, { ok: false, error: 'chatId missing' })
        if (manager.startIntegration && !manager.hasIntegration?.(integrationId)) {
          const integration = getIntegrationCredentialsById({ id: integrationId })
          if (integration?.enabled) await manager.startIntegration(integration)
        }
        const result = await manager.receiveExternalMessage(message)
        return sendJson(res, 200, { ok: true, result })
      }

      const userId = authenticate(req)
      if (!userId) return unauthorized(res)

      if (req.method === 'GET' && url.pathname === '/api/bridge/status') {
        return sendJson(res, 200, { ok: true, status: manager.getStatus?.() || [] })
      }

      if (req.method === 'GET' && url.pathname === '/api/bridge/wechat/qrcode') {
        const qr = await getWechatQrcode()
        const qrcodeUrl = await QRCode.toDataURL(qr.qrcodeText, { width: 280, margin: 2 })
        return sendJson(res, 200, { ok: true, qrcodeId: qr.qrcodeId, qrcodeText: qr.qrcodeText, qrcodeUrl })
      }

      if (req.method === 'POST' && url.pathname === '/api/bridge/wechat/qrcode/status') {
        const body = await readJson(req)
        const result = await pollWechatQrcode({ qrcodeId: body.qrcodeId })
        if (result.status === 'confirmed' && result.botToken) {
          const integration = upsertIntegration({
            userId,
            id: body.integrationId || undefined,
            provider: 'wechat_personal',
            name: body.name || 'WeChat Personal',
            enabled: true,
            config: {
              botId: result.botId || '',
              baseUrl: result.baseUrl || '',
              defaultAgentId: body.defaultAgentId || '',
            },
            secret: { botToken: result.botToken },
          })
          const full = getIntegrationCredentialsById({ id: integration.id })
          if (full?.enabled) await manager.startIntegration?.(full)
          return sendJson(res, 200, { ok: true, status: result.status, integration })
        }
        return sendJson(res, 200, { ok: true, ...result })
      }
    } catch (err) {
      return sendJson(res, err?.statusCode || 400, {
        ok: false,
        error: err?.message || 'bridge error',
        ...(err?.code ? { code: err.code } : {}),
      })
    }

    return sendJson(res, 404, { ok: false, error: 'unknown bridge route' })
  }
}

export const handleBridgeRequest = createBridgeRequestHandler()
