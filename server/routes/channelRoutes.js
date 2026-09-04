import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import {
  addAgentToChannel,
  archiveChannel,
  createChannel,
  getChannel,
  listChannels,
  listMessages,
  removeAgentFromChannel,
  subscribeChannelMessages,
  updateChannel,
} from '../services/channelStore.js'
import { dispatchUserMessage } from '../services/channelDispatcher.js'
import {
  describeModelReadinessFailure,
  isModelReadinessError,
} from '../services/modelReadinessService.js'
import { createStreamTicket, consumeStreamTicket } from '../utils/streamTicket.js'

function unauthorized(res) {
  return sendJson(res, 401, { ok: false, error: 'Unauthorized' })
}

function routeParts(pathname) {
  return pathname.split('/').filter(Boolean)
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function channelStreamScope(channelId) {
  return `channel:${channelId}`
}

function authForSse(req, url, channelId) {
  let userId = authenticateRequest(req)
  if (!userId) {
    const ticket = url.searchParams.get('ticket')
    if (ticket) userId = consumeStreamTicket(ticket, { scope: channelStreamScope(channelId) })
  }
  return userId
}

function statusForError(err) {
  if (err?.statusCode) return err.statusCode
  if (/does not belong to user/i.test(err?.message || '')) return 403
  if (/not found/i.test(err?.message || '')) return 404
  return 400
}

function handleChannelStreamTicket(req, res, channelId) {
  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)
  const channel = getChannel({ userId, channelId })
  if (!channel) return sendJson(res, 404, { ok: false, error: 'channel not found' })
  return sendJson(res, 201, {
    ok: true,
    ticket: createStreamTicket(userId, { scope: channelStreamScope(channelId) }),
    expiresIn: 60,
  })
}

function handleChannelStream(req, res, url, channelId) {
  const userId = authForSse(req, url, channelId)
  if (!userId) return unauthorized(res)
  const channel = getChannel({ userId, channelId })
  if (!channel) return sendJson(res, 404, { ok: false, error: 'channel not found' })
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  sendSse(res, 'ready', { ok: true, channelId })
  const unsubscribe = subscribeChannelMessages(channelId, (message) => {
    sendSse(res, 'channel_message', message)
  })
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n')
  }, 15_000)
  heartbeat.unref?.()
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    clearInterval(heartbeat)
    unsubscribe()
  }
  req.on('close', cleanup)
  res.on?.('close', cleanup)
  return undefined
}

async function handleChannelCollection(req, res, url, userId) {
  if (req.method === 'GET') {
    const channels = listChannels({
      userId,
      archived: url.searchParams.get('archived') || 'false',
      limit: url.searchParams.get('limit') || 200,
      offset: url.searchParams.get('offset') || 0,
    })
    return sendJson(res, 200, { ok: true, channels })
  }
  if (req.method === 'POST') {
    const body = await readJson(req)
    const channel = createChannel({
      userId,
      name: body.name,
      kind: body.kind || 'group',
      agentIds: Array.isArray(body.agentIds) ? body.agentIds : [],
      defaultAgentId: body.defaultAgentId || body.default_agent_id || null,
    })
    return sendJson(res, 200, { ok: true, channel })
  }
  return sendJson(res, 404, { ok: false, error: 'not found' })
}

async function handleChannelEntity(req, res, url, parts, userId, channelId) {
  if (req.method === 'GET' && parts.length === 3) {
    const channel = getChannel({ userId, channelId })
    return channel
      ? sendJson(res, 200, { ok: true, channel })
      : sendJson(res, 404, { ok: false, error: 'channel not found' })
  }
  if (req.method === 'PATCH' && parts.length === 3) {
    const body = await readJson(req)
    const patch = {}
    if ('name' in body) patch.name = body.name
    if ('defaultAgentId' in body || 'default_agent_id' in body) {
      patch.defaultAgentId = body.defaultAgentId ?? body.default_agent_id ?? null
    }
    if ('archived' in body) patch.archived = body.archived
    const channel = updateChannel({ userId, channelId, patch })
    return sendJson(res, 200, { ok: true, channel })
  }
  if (req.method === 'DELETE' && parts.length === 3) {
    const channel = archiveChannel({ userId, channelId, archived: true })
    return sendJson(res, 200, { ok: true, channel })
  }
  if (parts[3] === 'agents' && req.method === 'POST' && parts.length === 4) {
    const body = await readJson(req)
    const channel = addAgentToChannel({
      userId,
      channelId,
      agentId: body.agentId,
      role: body.role || 'member',
    })
    return sendJson(res, 200, { ok: true, channel })
  }
  if (parts[3] === 'agents' && req.method === 'DELETE' && parts[4]) {
    const result = removeAgentFromChannel({
      userId,
      channelId,
      agentId: decodeURIComponent(parts[4]),
    })
    return result.removed
      ? sendJson(res, 200, { ok: true, channel: result.channel })
      : sendJson(res, 404, { ok: false, error: 'agent membership not found' })
  }
  if (parts[3] === 'messages' && req.method === 'GET') {
    const messages = listMessages({
      userId,
      channelId,
      limit: url.searchParams.get('limit') || 50,
      before: url.searchParams.get('before') || null,
    })
    return sendJson(res, 200, { ok: true, messages })
  }
  if (parts[3] === 'messages' && req.method === 'POST') {
    const body = await readJson(req)
    const result = await dispatchUserMessage({
      channelId,
      userId,
      text: body.content ?? body.body ?? '',
      modelName: body.modelName ?? body.model_name ?? null,
      modelProviderId: body.modelProviderId ?? body.model_provider_id ?? null,
      modelConfigRevision: body.modelConfigRevision ?? body.model_config_revision ?? null,
      locale: body.locale,
    })
    return sendJson(res, 200, { ok: true, messageId: result.messageId, jobIds: result.jobIds })
  }
  return sendJson(res, 404, { ok: false, error: 'not found' })
}

export async function handleChannelRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const parts = routeParts(url.pathname)
  const channelId = parts[2] ? decodeURIComponent(parts[2]) : null
  if (req.method === 'POST' && channelId && parts[3] === 'stream-ticket' && parts.length === 4) {
    return handleChannelStreamTicket(req, res, channelId)
  }
  if (req.method === 'GET' && channelId && parts[3] === 'stream') {
    return handleChannelStream(req, res, url, channelId)
  }
  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)
  try {
    if (url.pathname === '/api/channels') return await handleChannelCollection(req, res, url, userId)
    if (parts[0] === 'api' && parts[1] === 'channels' && channelId) {
      return await handleChannelEntity(req, res, url, parts, userId, channelId)
    }
    return sendJson(res, 404, { ok: false, error: 'not found' })
  } catch (err) {
    if (isModelReadinessError(err)) {
      const failure = describeModelReadinessFailure(err)
      return sendJson(res, failure.statusCode, { ok: false, error: failure.error })
    }
    return sendJson(res, statusForError(err), {
      ok: false,
      error: err?.message || String(err),
    })
  }
}
