import { WebSocketServer } from 'ws'
import { getSessionByToken } from '../db.js'
import { listTurnEvents, subscribeTurnEvents } from './turnEventStore.js'
import { decideApproval, getPendingApproval } from './approvalStore.js'
import { releaseApproval } from './approvalGate.js'
import { getJobRuntime } from './jobRuntime.js'

const VALID_DECISIONS = new Set(['approve', 'deny', 'edit'])
const CROSS_PROCESS_POLL_MS = 1_000

function send(socket, value) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value))
}

function tokenFromRequest(request) {
  const url = new URL(request.url, 'http://localhost')
  const protocol = String(request.headers['sec-websocket-protocol'] || '')
    .split(',').map((value) => value.trim())
  const bearer = protocol.find((value) => value.startsWith('bearer.'))
  return url.searchParams.get('token') || (bearer ? bearer.slice(7) : null)
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
      send(socket, { type: 'turn.event', event })
    }
    const pollSubscriptions = () => {
      for (const subscription of subscriptions.values()) {
        const events = listTurnEvents({
          userId: request.userId,
          sessionId: subscription.sessionId,
          turnId: subscription.turnId,
          after: subscription.cursor,
          limit: 2_000,
        })
        for (const event of events) deliver(subscription, event)
      }
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
      let message
      try { message = JSON.parse(String(raw)) } catch {
        send(socket, { type: 'error', code: 'INVALID_JSON' })
        return
      }
      if (message?.type === 'subscribe.turn') {
        const sessionId = String(message.sessionId || '')
        const turnId = String(message.turnId || '')
        const after = Number.isFinite(Number(message.after)) ? Math.floor(Number(message.after)) : -1
        if (!sessionId || !turnId) {
          send(socket, { type: 'error', code: 'TURN_TARGET_REQUIRED' })
          return
        }
        const key = `${sessionId}\u0000${turnId}`
        subscriptions.get(key)?.unsubscribe()
        const subscription = { sessionId, turnId, cursor: after, unsubscribe: () => {} }
        // Subscribe before replaying the durable log. The cursor makes the
        // local callback, replay, and cross-process poll idempotent while also
        // closing the old replay/subscribe race window.
        subscription.unsubscribe = subscribeTurnEvents(
          { userId: request.userId, sessionId, turnId },
          (event) => deliver(subscription, event),
        )
        subscriptions.set(key, subscription)
        for (const event of listTurnEvents({ userId: request.userId, sessionId, turnId, after, limit: 2_000 })) {
          deliver(subscription, event)
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
        const existing = getPendingApproval({ userId: request.userId, id })
        if (!existing) {
          send(socket, { type: 'error', code: 'APPROVAL_NOT_FOUND' })
          return
        }
        const result = decideApproval({
          userId: request.userId,
          id,
          decision,
          editedArgs: decision === 'edit' ? message.args : null,
          decidedBy: request.userId,
        })
        releaseApproval(id)
        if (existing.origin === 'job' && existing.jobId) {
          getJobRuntime().resumeAfterApproval(existing.jobId, { userId: request.userId, stepId: existing.stepId })
        }
        send(socket, { type: 'approval.resolved', approvalId: id, result })
      }
    })
    socket.on('close', clearSubscriptions)
    socket.on('error', clearSubscriptions)
  })

  server.once('close', () => webSocketServer.close())
  return webSocketServer
}
