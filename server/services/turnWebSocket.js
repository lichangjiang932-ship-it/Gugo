import { WebSocketServer } from 'ws'
import { getSessionByToken } from '../db.js'
import { listTurnEvents, subscribeTurnEvents, turnEventForClient } from './turnEventStore.js'
import { subscribeTurnActivities } from './turnActivityBus.js'
import { decideApprovalRequest } from './approvalDecisionService.js'
import { logWarn } from '../utils/logger.js'
import {
  createTurnWebSocketFrame,
  validateTurnWebSocketClientFrame,
} from '../../shared/turnWebSocketProtocol.js'

const VALID_DECISIONS = new Set(['approve', 'deny', 'edit'])
const CROSS_PROCESS_POLL_MS = 1_000

function send(socket, value) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(createTurnWebSocketFrame(value.type, value)))
  }
}

function tokenFromRequest(request) {
  const url = new URL(request.url, 'http://localhost')
  const protocol = String(request.headers['sec-websocket-protocol'] || '')
    .split(',').map((value) => value.trim())
  const bearer = protocol.find((value) => value.startsWith('bearer.'))
  return url.searchParams.get('token') || (bearer ? bearer.slice(7) : null)
}

function logRejectedClientFrame(rejection, { userId, sink } = {}) {
  logWarn('realtime.protocol', 'rejected client frame', {
    userId,
    code: rejection.code,
    expectedVersion: rejection.expectedVersion,
    receivedVersion: rejection.receivedVersion,
    issueCount: rejection.issues?.length,
  }, sink)
}

export function parseTurnWebSocketClientFrame(raw, { userId, logSink } = {}) {
  let message
  try {
    message = JSON.parse(String(raw))
  } catch {
    const rejection = { ok: false, code: 'INVALID_JSON' }
    logRejectedClientFrame(rejection, { userId, sink: logSink })
    return rejection
  }

  const validation = validateTurnWebSocketClientFrame(message)
  if (!validation.ok) {
    logRejectedClientFrame(validation, { userId, sink: logSink })
  }
  return validation
}

export function pollTurnSubscriptions({
  subscriptions,
  userId,
  deliver,
  listEvents = listTurnEvents,
  onError = (error, subscription) => console.error(
    `[realtime] failed to poll turn ${subscription.turnId}:`,
    error?.stack || error,
  ),
}) {
  for (const subscription of subscriptions.values()) {
    try {
      const events = listEvents({
        userId,
        sessionId: subscription.sessionId,
        turnId: subscription.turnId,
        after: subscription.cursor,
        limit: 2_000,
      })
      for (const event of events) deliver(subscription, event)
    } catch (error) {
      onError?.(error, subscription)
    }
  }
}

export function subscribeTurnSubscription({
  subscriptions,
  key,
  userId,
  sessionId,
  turnId,
  after,
  deliver,
  deliverActivity = () => {},
  subscribe = subscribeTurnEvents,
  subscribeActivities = subscribeTurnActivities,
  listEvents = listTurnEvents,
}) {
  const previous = subscriptions.get(key)
  previous?.unsubscribe()
  subscriptions.delete(key)
  let unsubscribeEvents = () => {}
  let unsubscribeActivities = () => {}
  const subscription = {
    sessionId,
    turnId,
    cursor: after,
    unsubscribe: () => {
      unsubscribeEvents()
      unsubscribeActivities()
    },
  }
  try {
    // Subscribe before replaying the durable log. The cursor makes the
    // local callback, replay, and cross-process poll idempotent while also
    // closing the old replay/subscribe race window.
    unsubscribeEvents = subscribe(
      { userId, sessionId, turnId },
      (event) => deliver(subscription, event),
    )
    unsubscribeActivities = subscribeActivities(
      { userId, sessionId, turnId },
      (activity) => deliverActivity(subscription, activity),
    )
    subscriptions.set(key, subscription)
    for (const event of listEvents({ userId, sessionId, turnId, after, limit: 2_000 })) {
      deliver(subscription, event)
    }
    return subscription
  } catch (error) {
    try { subscription.unsubscribe() } catch { /* best-effort cleanup */ }
    if (subscriptions.get(key) === subscription) subscriptions.delete(key)
    throw error
  }
}

export function attachTurnWebSocketServer(server) {
  const webSocketServer = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname !== '/api/realtime') return
    const token = tokenFromRequest(request)
    const session = token ? getSessionByToken(token) : null
    if (!session?.user_id) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    request.userId = session.user_id
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit('connection', client, request)
    })
  })

  webSocketServer.on('connection', (socket, request) => {
    const subscriptions = new Map()
    const deliver = (subscription, event) => {
      if (!event || event.sequence <= subscription.cursor) return
      subscription.cursor = event.sequence
      send(socket, { type: 'turn.event', event: turnEventForClient(event) })
    }
    const deliverActivity = (_subscription, activity) => {
      if (activity) send(socket, { type: 'turn.activity', activity })
    }
    const pollSubscriptions = () => {
      pollTurnSubscriptions({ subscriptions, userId: request.userId, deliver })
    }
    const pollTimer = setInterval(pollSubscriptions, CROSS_PROCESS_POLL_MS)
    pollTimer.unref?.()
    const clearSubscriptions = () => {
      clearInterval(pollTimer)
      for (const subscription of subscriptions.values()) subscription.unsubscribe()
      subscriptions.clear()
    }
    send(socket, { type: 'ready' })

    socket.on('message', (raw) => {
      const validation = parseTurnWebSocketClientFrame(raw, { userId: request.userId })
      if (!validation.ok) {
        send(socket, {
          type: 'error',
          code: validation.code,
          message: validation.message,
          ...(validation.code === 'VERSION_MISMATCH'
            ? {
                expectedVersion: validation.expectedVersion,
                receivedVersion: validation.receivedVersion,
              }
            : {}),
        })
        return
      }
      const message = validation.value
      if (message?.type === 'subscribe.turn') {
        const sessionId = String(message.sessionId || '')
        const turnId = String(message.turnId || '')
        const after = Number.isFinite(Number(message.after)) ? Math.floor(Number(message.after)) : -1
        if (!sessionId || !turnId) {
          send(socket, { type: 'error', code: 'TURN_TARGET_REQUIRED' })
          return
        }
        const key = `${sessionId}\u0000${turnId}`
        try {
          subscribeTurnSubscription({
            subscriptions,
            key,
            userId: request.userId,
            sessionId,
            turnId,
            after,
            deliver,
            deliverActivity,
          })
        } catch (error) {
          console.error(`[realtime] failed to subscribe turn ${turnId}:`, error?.stack || error)
          send(socket, { type: 'error', code: 'TURN_SUBSCRIBE_FAILED', sessionId, turnId })
          try { socket.close(1011, 'Turn subscription failed') } catch { /* already closed */ }
          return
        }
        send(socket, { type: 'subscribed.turn', sessionId, turnId })
        return
      }
      if (message?.type === 'approval.decide') {
        const id = String(message.approvalId || '')
        const decision = String(message.decision || '')
        if (!id || !VALID_DECISIONS.has(decision)) {
          send(socket, { type: 'error', code: 'INVALID_APPROVAL_DECISION' })
          return
        }
        try {
          const result = decideApprovalRequest({
            userId: request.userId,
            id,
            decision,
            editedArgs: decision === 'edit' ? message.args : null,
            decidedBy: request.userId,
          })
          send(socket, { type: 'approval.resolved', approvalId: id, result })
        } catch (error) {
          send(socket, {
            type: 'error',
            code: error?.code || 'APPROVAL_DECISION_FAILED',
            message: error?.message || 'Approval decision failed.',
          })
        }
      }
    })
    socket.on('close', clearSubscriptions)
    socket.on('error', clearSubscriptions)
  })

  server.once('close', () => webSocketServer.close())
  return webSocketServer
}
