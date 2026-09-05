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
import { createNotification } from './notificationsStore.js'
import {
  getBridgeContact,
  getParkedBridgeMessage,
  parkBridgeMessage,
  setBridgeContactStatus,
  transitionParkedBridgeMessage,
} from './bridgeParkingStore.js'

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

function sanitizedInboundPayload(message, provider = '') {
  const omitCredentialUrl = cleanString(provider).toLowerCase() === 'telegram'
  return {
    text: cleanString(message.text),
    isGroup: !!message.isGroup,
    messageId: cleanString(message.messageId) || null,
    attachments: (Array.isArray(message.attachments) ? message.attachments : [])
      .slice(0, 20)
      .map((item) => ({
        type: cleanString(item?.type),
        url: omitCredentialUrl ? null : (cleanString(item?.url) || null),
        platformRef: cleanString(item?.platformRef) || null,
        filename: cleanString(item?.filename) || null,
        mimeType: cleanString(item?.mimeType || item?.mime) || null,
        size: Number.isFinite(Number(item?.size)) ? Number(item.size) : null,
        width: Number.isFinite(Number(item?.width)) ? Number(item.width) : null,
        height: Number.isFinite(Number(item?.height)) ? Number(item.height) : null,
      })),
  }
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

function resolveBridgeAgent(runtime, { userId, config }) {
  const wanted = cleanString(config?.defaultAgentId || config?.agentId)
  if (wanted) {
    const agent = getAgent({ userId, id: wanted })
    if (agent) return agent
  }
  return ensureDefaultAgent({ userId })
}

function ensureBridgeSession(runtime, {
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
  const agent = resolveBridgeAgent(runtime, { userId, config })
  const channel = createChannel({
    userId,
    name: [platformLabel(provider), isGroup ? 'group' : 'dm', senderName || chatId]
      .filter(Boolean).join(' / '),
    kind: isGroup ? 'group' : 'dm',
    agentIds: [agent.id],
    defaultAgentId: agent.id,
  })
  return insertBridgeSession({
    userId, integrationId, provider, chatId, chatType,
    externalUserId, senderName, channelId: channel.id,
  })
}

async function buildInboundText(runtime, {
  userId,
  integrationId,
  provider,
  text,
  attachments = [],
}) {
  const base = cleanString(text)
  const images = attachments.filter(isImageAttachment)
  if (!images.length) return base
  const entry = runtime.adapters.get(adapterKey(provider, integrationId))
  const resolveAttachment = typeof entry?.adapter?.resolveAttachment === 'function'
    ? (attachment) => entry.adapter.resolveAttachment(attachment)
    : null
  let descriptions
  try {
    descriptions = await runtime.describeAttachments({
      userId,
      attachments: images,
      ...(resolveAttachment ? { resolveAttachment } : {}),
    })
  } catch (error) {
    descriptions = images.map((_, index) => ({
      index, ok: false, error: error?.message || String(error),
    }))
  }
  const blocks = descriptions.map((item, offset) => {
    const index = Number.isInteger(item?.index) ? item.index + 1 : offset + 1
    const body = item?.ok === false
      ? `failed: ${item.error || item.message || 'unknown error'}`
      : cleanString(item?.description || item?.text)
    return `[Image ${index} description]\n${body || '(empty)'}`
  })
  return [base, ...blocks].filter(Boolean).join('\n\n')
}

function waitForAgentReply(runtime, { channelId, parentMessageId }) {
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
      if (message?.senderKind === 'agent' && message.parentMessageId === parentMessageId) {
        finish(message)
      }
    })
    const timer = setTimeout(() => finish(null), runtime.replyTimeoutMs)
  })
}

async function stopBridgeIntegration(runtime, integrationId, provider = null) {
  const keys = []
  for (const key of runtime.adapters.keys()) {
    if (key.endsWith(`:${integrationId}`)
      && (!provider || key.startsWith(`${provider}:`))) keys.push(key)
  }
  for (const key of keys) {
    const entry = runtime.adapters.get(key)
    try { await entry?.adapter?.stop?.() } catch { /* best effort */ }
    runtime.adapters.delete(key)
  }
  runtime.integrations.delete(integrationId)
}

async function startBridgeIntegration(runtime, integration) {
  if (!integration?.id) throw new Error('integration required')
  const provider = integration.provider
  const key = adapterKey(provider, integration.id)
  await stopBridgeIntegration(runtime, integration.id, provider)
  runtime.integrations.set(integration.id, integration)
  const factory = runtime.adapterFactories[provider]
  if (!factory) {
    runtime.adapters.set(key, { status: 'configured', adapter: null, error: null })
    return { ok: true, status: 'configured' }
  }
  const entry = { status: 'starting', adapter: null, error: null }
  runtime.adapters.set(key, entry)
  try {
    const adapter = await factory({
      integration,
      onMessage: (message) => receiveExternalMessage(runtime, {
        ...message, integrationId: integration.id, provider,
      }),
    })
    entry.adapter = adapter
    await adapter?.start?.()
    entry.status = 'connected'
    return { ok: true, status: entry.status }
  } catch (error) {
    entry.status = 'error'
    entry.error = error?.message || String(error)
    return { ok: false, status: entry.status, error: entry.error }
  }
}

async function sendBridgeReply(runtime, { integrationId, provider, chatId, text, context = {} }) {
  const entry = runtime.adapters.get(adapterKey(provider, integrationId))
  if (!entry?.adapter?.sendMessage) return { ok: false, error: 'adapter is not running' }
  await entry.adapter.sendMessage({ chatId, text, context })
  return { ok: true }
}

async function receiveExternalMessage(runtime, message = {}) {
  const integrationId = cleanString(message.integrationId)
  const provider = cleanString(message.provider)
  const chatId = cleanString(message.chatId)
  if (!integrationId || !provider || !chatId) {
    throw new Error('integrationId + provider + chatId required')
  }
  const integration = runtime.integrations.get(integrationId)
  if (!integration) throw new Error('integration is not running')
  const userId = integrationUserId(integration)
  const externalUserId = cleanString(message.externalUserId || message.userId || chatId)
  const senderName = cleanString(message.senderName)
  const config = integrationConfig(integration)
  const contact = getBridgeContact({ userId, integrationId, provider, externalUserId })
  const inboundPolicy = cleanString(config?.inboundPolicy || 'contacts')
  if (message.__bypassParking !== true && inboundPolicy !== 'open' && contact?.status !== 'allowed') {
    if (contact?.status === 'blocked') {
      return { ok: true, blocked: true, parked: false, replied: false }
    }
    const parked = parkBridgeMessage({
      userId, integrationId, provider, chatId, externalUserId, senderName,
      payload: sanitizedInboundPayload(message, provider),
    })
    try {
      createNotification({
        userId,
        kind: 'approval',
        title: `New ${platformLabel(provider)} contact`,
        body: `${senderName || externalUserId} sent a message. Allow and deliver it?`,
        link: `/access?bridgeParkingId=${encodeURIComponent(parked.id)}`,
        data: { bridgeParkingId: parked.id, integrationId, provider, externalUserId },
      })
    } catch (error) {
      console.error('[bridge] parking notification failed:', error?.stack || error)
    }
    return { ok: true, parked: true, parkingId: parked.id, replied: false }
  }
  const bridgeSession = ensureBridgeSession(runtime, {
    integration,
    provider,
    chatId,
    chatType: message.isGroup ? 'group' : 'dm',
    externalUserId,
    senderName,
    isGroup: !!message.isGroup,
  })
  const text = await buildInboundText(runtime, {
    userId, integrationId, provider, text: message.text, attachments: message.attachments || [],
  })
  const dispatch = await dispatchUserMessage({ channelId: bridgeSession.channelId, userId, text })
  const reply = await waitForAgentReply(runtime, {
    channelId: bridgeSession.channelId,
    parentMessageId: dispatch.messageId,
  })
  if (reply?.content) {
    await sendBridgeReply(runtime, {
      integrationId, provider, chatId, text: reply.content, context: message,
    })
  }
  return {
    ok: true,
    channelId: bridgeSession.channelId,
    messageId: dispatch.messageId,
    replied: !!reply?.content,
  }
}

async function allowAndDeliver(runtime, { userId, parkingId } = {}) {
  const parked = getParkedBridgeMessage({ userId, id: parkingId })
  if (!parked) return null
  if (parked.status === 'delivered') return { ok: true, parked, alreadyDelivered: true }
  if (parked.status !== 'parked' && parked.status !== 'failed') {
    return { ok: false, parked, error: `message is ${parked.status}` }
  }
  setBridgeContactStatus({
    userId,
    integrationId: parked.integrationId,
    provider: parked.provider,
    externalUserId: parked.externalUserId,
    displayName: parked.senderName,
    status: 'allowed',
  })
  const claimed = transitionParkedBridgeMessage({
    userId, id: parkingId, from: parked.status, to: 'delivering',
  })
  if (!claimed) return { ok: false, error: 'message state changed; refresh and retry' }
  try {
    const delivered = await receiveExternalMessage(runtime, {
      ...parked.payload,
      integrationId: parked.integrationId,
      provider: parked.provider,
      chatId: parked.chatId,
      externalUserId: parked.externalUserId,
      senderName: parked.senderName,
      __bypassParking: true,
    })
    const updated = transitionParkedBridgeMessage({
      userId, id: parkingId, from: 'delivering', to: 'delivered',
    })
    return { ok: true, delivered, parked: updated }
  } catch (error) {
    transitionParkedBridgeMessage({
      userId, id: parkingId, from: 'delivering', to: 'failed',
      error: error?.message || String(error),
    })
    throw error
  }
}

function rejectParked(runtime, { userId, parkingId } = {}) {
  const parked = getParkedBridgeMessage({ userId, id: parkingId })
  if (!parked) return null
  if (parked.status !== 'parked') {
    return { ok: false, parked, error: `message is ${parked.status}` }
  }
  setBridgeContactStatus({
    userId,
    integrationId: parked.integrationId,
    provider: parked.provider,
    externalUserId: parked.externalUserId,
    displayName: parked.senderName,
    status: 'blocked',
  })
  const updated = transitionParkedBridgeMessage({
    userId, id: parkingId, from: 'parked', to: 'rejected',
  })
  return { ok: true, parked: updated }
}

function stopAllBridges(runtime) {
  const operations = [...runtime.adapters.keys()].map(async (key) => {
    const entry = runtime.adapters.get(key)
    try { await entry?.adapter?.stop?.() } catch { /* best effort */ }
    runtime.adapters.delete(key)
  })
  return Promise.all(operations).then(() => { runtime.integrations.clear() })
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
  const runtime = {
    adapterFactories,
    describeAttachments,
    replyTimeoutMs,
    adapters: new Map(),
    integrations: new Map(),
  }
  return {
    startIntegration: (integration) => startBridgeIntegration(runtime, integration),
    hasIntegration: (integrationId) => runtime.integrations.has(integrationId),
    stopIntegration: (integrationId, provider = null) => (
      stopBridgeIntegration(runtime, integrationId, provider)
    ),
    stopAll: () => stopAllBridges(runtime),
    receiveExternalMessage: (message) => receiveExternalMessage(runtime, message),
    allowAndDeliver: (input) => allowAndDeliver(runtime, input),
    rejectParked: (input) => rejectParked(runtime, input),
    sendReply: (input) => sendBridgeReply(runtime, input),
    getStatus: () => [...runtime.adapters.entries()].map(([key, entry]) => {
      const [provider, integrationId] = key.split(':')
      return { integrationId, provider, status: entry.status, error: entry.error || null }
    }),
  }
}

export const socialBridgeManager = createSocialBridgeManager()
