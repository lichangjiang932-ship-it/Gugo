import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import {
  countUnreadNotifications,
  deleteNotification,
  listNotifications,
  markAllRead,
  markRead,
  subscribeNotifications,
} from '../services/notificationsStore.js'
import { createStreamTicket, consumeStreamTicket } from '../utils/streamTicket.js'

const NOTIFICATION_STREAM_SCOPE = 'notifications'

function unauthorized(res) {
  return sendJson(res, 401, { error: 'Unauthorized' })
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function routeParts(pathname) {
  return pathname.split('/').filter(Boolean)
}

export async function handleNotificationRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const parts = routeParts(url.pathname)

  if (req.method === 'POST' && url.pathname === '/api/notifications/stream-ticket') {
    const userId = authenticateRequest(req)
    if (!userId) return unauthorized(res)
    return sendJson(res, 201, {
      ticket: createStreamTicket(userId, { scope: NOTIFICATION_STREAM_SCOPE }),
      expiresIn: 60,
    })
  }

  if (req.method === 'GET' && url.pathname === '/api/notifications/stream') {
    let userId = authenticateRequest(req)
    if (!userId) {
      const ticket = url.searchParams.get('ticket')
      if (ticket) userId = consumeStreamTicket(ticket, { scope: NOTIFICATION_STREAM_SCOPE })
    }
    if (!userId) return unauthorized(res)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()
    sendSse(res, 'ready', { ok: true })
    const unsubscribe = subscribeNotifications(userId, (notification) => {
      sendSse(res, 'notification', notification)
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
    return
  }

  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)

  if (req.method === 'GET' && url.pathname === '/api/notifications') {
    const unread = url.searchParams.get('unread') === '1'
    const limit = Number(url.searchParams.get('limit') || 50)
    const offset = Number(url.searchParams.get('offset') || 0)
    const notifications = listNotifications({ userId, unread, limit, offset })
    return sendJson(res, 200, { notifications })
  }

  if (req.method === 'GET' && url.pathname === '/api/notifications/unread-count') {
    return sendJson(res, 200, { count: countUnreadNotifications(userId) })
  }

  if (req.method === 'POST' && url.pathname === '/api/notifications/mark-read') {
    const body = await readJson(req)
    const changed = body?.all
      ? markAllRead(userId)
      : markRead(Array.isArray(body?.ids) ? body.ids : [], { userId })
    return sendJson(res, 200, {
      ok: true,
      changed,
      unreadCount: countUnreadNotifications(userId),
    })
  }

  if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'notifications' && parts[2]) {
    const changed = deleteNotification(decodeURIComponent(parts[2]), { userId })
    return changed
      ? sendJson(res, 200, { ok: true })
      : sendJson(res, 404, { error: 'notification not found' })
  }

  return sendJson(res, 404, { error: 'not found' })
}
