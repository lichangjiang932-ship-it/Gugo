import crypto from 'node:crypto'
import { getDb } from '../db.js'
import { createChannel, getChannel, subscribeChannelMessages } from './channelStore.js'
import { dispatchUserMessage } from './channelDispatcher.js'
import { ensureDefaultAgent, getAgent } from './agentStore.js'
import { describeImageAttachments } from '../adapters/visionAssist.js'
import { createTelegramBridgeAdapter } from '../adapters/social/telegramBridge.js'
import { createFeishuBridgeAdapter } from '../adapters/social/feishuBridge.js'
import { createQQBridgeAdapter } from '../adapters/social/qqBridge.js'
import { createWechatIlinkBridgeAdapter } from '../adapters/social/wechatIlinkBridge.js'

function newId() {
  return crypto.randomUUID?.() || `bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function now() {
  return Date.now()
}

function cleanString(value) {
  return String(value ?? '').trim()
}

function platformLabel(provider) {
  return ({
    telegram: 'Telegram',
    feishu: 'Feishu',
    qq: 'QQ',
    wechat_personal: 'WeChat',
    wechat: 'WeChat',
  })[provider] || provider || 'Bridge'
}

function isImageAttachment(item) {
  const type = String(item?.type || '').toLowerCase()
  const mime = String(item?.mimeType || item?.mime || '').toLowerCase()
  return type === 'image' || mime.startsWith('image/')
}

async function noopDescribeAttachments() {
  return []
}

function rowToBridgeSession(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    integrationId: row.integration_id,
    provider: row.provider,
    externalChatId: row.external_chat_id,
    chatType: row.chat_type,
    externalUserId: row.external_user_id || null,
    externalUsername: row.external_username || null,
    channelId: row.channel_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function integrationUserId(integration) {
  return integration?.userId || integration?.user_id || null
}

function integrationConfig(integration) {
  return integration?.config || integration?.config_json || {}
}

function adapterKey(provider, integrationId) {
  return `${provider}:${integrationId}`
}

function getSessionByExternal({ userId, integrationId, provider, chatId }) {
  const row = getDb().prepare(`
    SELECT * FROM bridge_sessions
    WHERE user_id = ? AND integration_id = ? AND provider = ? AND external_chat_id = ?
  `).get(userId, integrationId, provider, chatId)
  return rowToBridgeSession(row)
}

function insertBridgeSession({
  userId,
  integrationId,
  provider,
  chatId,
  chatType,
  externalUserId,
  senderName,
  channelId,
}) {
  const ts = now()
  const id = newId()
  getDb().prepare(`
    INSERT INTO bridge_sessions
      (id, user_id, integration_id, provider, external_chat_id, chat_type, external_user_id, external_username, channel_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    integrationId,
    provider,
    chatId,
    chatType,
    externalUserId || null,
    senderName || null,
    channelId,
    ts,
    ts,
  )
  return getSessionByExternal({ userId, integrationId, provider, chatId })
}

function updateBridgeSessionTouch({ sessionId, externalUserId, senderName }) {
  getDb().prepare(`
    UPDATE bridge_sessions
    SET external_user_id = COALESCE(?, external_user_id),
        external_username = COALESCE(?, external_username),
        updated_at = ?
    WHERE id = ?
  `).run(externalUserId || null, senderName || null, now(), sessionId)
}

export function createSocialBridgeManager({
  adapterFactories = {
    telegram: createTelegramBridgeAdapter,
    feishu: createFeishuBridgeAdapter,
    qq: createQQBridgeAdapter,
    wechat_personal: createWechatIlinkBridgeAdapter,
    wechat: createWechatIlinkBridgeAdapter,
  },
  describeAttachments = describeImageAttachments || noopDescribeAttachments,
  replyTimeoutMs = 60_000,
} = {}) {
  const adapters = new Map()
  const integrations = new Map()

  function resolveAgent({ userId, config }) {
    const wanted = cleanString(config?.defaultAgentId || config?.agentId)
    if (wanted) {
      const agent = getAgent({ userId, id: wanted })
      if (agent) return agent
    }
    return ensureDefaultAgent({ userId })
  }

  function ensureBridgeSession({
    integration,
    provider,
    chatId,
    chatType,
    externalUserId,
    senderName,
    isGroup,
  }) {
    const userId = integrationUserId(integration)
    if (!userId) throw new Error('integration userId required')
    const integrationId = integration.id
    const existing = getSessionByExternal({ userId, integrationId, provider, chatId })
    if (existing && getChannel({ userId, channelId: existing.channelId })) {
      updateBridgeSessionTouch({ sessionId: existing.id, externalUserId, senderName })
      return existing
    }

    const config = integrationConfig(integration)
    const agent = resolveAgent({ userId, config })
    const nameBits = [
      platformLabel(provider),
      isGroup ? 'group' : 'dm',
      senderName || chatId,
    ].filter(Boolean)
    const channel = createChannel({
      userId,
      name: nameBits.join(' / '),
      kind: isGroup ? 'group' : 'dm',
      agentIds: [agent.id],
      defaultAgentId: agent.id,
    })
    return insertBridgeSession({
      userId,
      integrationId,
      provider,
      chatId,
      chatType,
      externalUserId,
      senderName,
      channelId: channel.id,
    })
  }

  async function buildInboundText({ userId, text, attachments = [] }) {
    const base = cleanString(text)
    const images = attachments.filter(isImageAttachment)
    if (!images.length) return base
    let descriptions = []
    try {
      descriptions = await describeAttachments({ userId, attachments: images })
    } catch (err) {
      descriptions = images.map((_, index) => ({
        index,
        ok: false,
        error: err?.message || String(err),
      }))
    }
    const blocks = descriptions.map((item, i) => {
      const index = Number.isInteger(item?.index) ? item.index + 1 : i + 1
      const body = item?.ok === false
        ? `failed: ${item.error || item.message || 'unknown error'}`
        : cleanString(item?.description || item?.text)
      return `[Image ${index} description]\n${body || '(empty)'}`
    })
    return [base, ...blocks].filter(Boolean).join('\n\n')
  }

  function waitForAgentReply({ channelId, parentMessageId }) {
    const existing = getDb().prepare(`
      SELECT content, sender_kind AS senderKind, parent_message_id AS parentMessageId
      FROM channel_messages
      WHERE channel_id = ? AND sender_kind = 'agent' AND parent_message_id = ?
      ORDER BY created_at ASC
      LIMIT 1
    `).get(channelId, parentMessageId)
    if (existing) return Promise.resolve(existing)

    return new Promise((resolve) => {
      let done = false
      const finish = (message = null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        unsubscribe()
        resolve(message)
      }
      const unsubscribe = subscribeChannelMessages(channelId, (message) => {
        if (message?.senderKind !== 'agent') return
        if (message.parentMessageId !== parentMessageId) return
        finish(message)
      })
      const timer = setTimeout(() => finish(null), replyTimeoutMs)
    })
  }

  async function startIntegration(integration) {
    if (!integration?.id) throw new Error('integration required')
    const provider = integration.provider
    const key = adapterKey(provider, integration.id)
    await stopIntegration(integration.id, provider)
    integrations.set(integration.id, integration)
    const factory = adapterFactories[provider]
    if (!factory) {
      adapters.set(key, { status: 'configured', adapter: null, error: null })
      return { ok: true, status: 'configured' }
    }
    const entry = { status: 'starting', adapter: null, error: null }
    adapters.set(key, entry)
    try {
      const adapter = await factory({
        integration,
        onMessage: (message) => receiveExternalMessage({ ...message, integrationId: integration.id, provider }),
      })
      entry.adapter = adapter
      await adapter?.start?.()
      entry.status = 'connected'
      return { ok: true, status: entry.status }
    } catch (err) {
      entry.status = 'error'
      entry.error = err?.message || String(err)
      return { ok: false, status: entry.status, error: entry.error }
    }
  }

  function hasIntegration(integrationId) {
    return integrations.has(integrationId)
  }

  async function stopIntegration(integrationId, provider = null) {
    const keys = []
    for (const key of adapters.keys()) {
      if (key.endsWith(`:${integrationId}`) && (!provider || key.startsWith(`${provider}:`))) keys.push(key)
    }
    for (const key of keys) {
      const entry = adapters.get(key)
      try { await entry?.adapter?.stop?.() } catch { /* best effort */ }
      adapters.delete(key)
    }
    integrations.delete(integrationId)
  }

  async function sendReply({ integrationId, provider, chatId, text, context = {} }) {
    const entry = adapters.get(adapterKey(provider, integrationId))
    if (!entry?.adapter?.sendMessage) return { ok: false, error: 'adapter is not running' }
    await entry.adapter.sendMessage({ chatId, text, context })
    return { ok: true }
  }

  async function receiveExternalMessage(message = {}) {
    const integrationId = cleanString(message.integrationId)
    const provider = cleanString(message.provider)
    const chatId = cleanString(message.chatId)
    if (!integrationId || !provider || !chatId) throw new Error('integrationId + provider + chatId required')
    const integration = integrations.get(integrationId)
    if (!integration) throw new Error('integration is not running')
    const userId = integrationUserId(integration)
    const bridgeSession = ensureBridgeSession({
      integration,
      provider,
      chatId,
      chatType: message.isGroup ? 'group' : 'dm',
      externalUserId: cleanString(message.externalUserId || message.userId),
      senderName: cleanString(message.senderName),
      isGroup: !!message.isGroup,
    })
    const text = await buildInboundText({
      userId,
      text: message.text,
      attachments: message.attachments || [],
    })
    const dispatch = await dispatchUserMessage({
      channelId: bridgeSession.channelId,
      userId,
      text,
    })
    const reply = await waitForAgentReply({
      channelId: bridgeSession.channelId,
      parentMessageId: dispatch.messageId,
    })
    if (reply?.content) {
      await sendReply({
        integrationId,
        provider,
        chatId,
        text: reply.content,
        context: message,
      })
    }
    return {
      ok: true,
      channelId: bridgeSession.channelId,
      messageId: dispatch.messageId,
      replied: !!reply?.content,
    }
  }

  function getStatus() {
    return [...adapters.entries()].map(([key, entry]) => {
      const [provider, integrationId] = key.split(':')
      return {
        integrationId,
        provider,
        status: entry.status,
        error: entry.error || null,
      }
    })
  }

  async function stopAll() {
    const keys = [...adapters.keys()]
    for (const key of keys) {
      const entry = adapters.get(key)
      try { await entry?.adapter?.stop?.() } catch { /* best effort */ }
      adapters.delete(key)
    }
    integrations.clear()
  }

  return {
    startIntegration,
    hasIntegration,
    stopIntegration,
    stopAll,
    receiveExternalMessage,
    sendReply,
    getStatus,
  }
}

export const socialBridgeManager = createSocialBridgeManager()
