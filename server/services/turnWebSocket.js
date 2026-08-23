import { WebSocketServer } from 'ws'
import { getSessionByToken } from '../db.js'
import { describeTurnEngineHostUnavailableError } from './turnEngineHostErrorContract.js'
import {
  listTurnEvents,
  subscribeTurnEvents,
  TurnEventSequenceGapError,
  turnEventForClient,
} from './turnEventStore.js'
import { subscribeTurnActivities } from './turnActivityBus.js'
import { decideApprovalRequest } from './approvalDecisionService.js'
import { logWarn } from '../utils/logger.js'
import {
  createTurnWebSocketFrame,
  validateTurnWebSocketClientFrame,
} from '../../shared/turnWebSocketProtocol.js'
import {
  TURN_EVENT_TRANSPORT_TYPE,
  canAdvanceTurnEventCursor,
  createTurnEventTransportEnvelope,
} from '../../shared/turnEvents.js'
import { isHttpServerDraining } from '../core/httpServerDrain.js'
import { runtimeNotReadyMessage } from '../core/runtimeReadiness.js'

const VALID_DECISIONS = new Set(['approve', 'deny', 'edit'])
const CROSS_PROCESS_POLL_MS = 1_000
const TURN_EVENT_PAGE_LIMIT = 2_000

function send(socket, value) {
  if (socket.readyState === socket.OPEN) {
    const frame = value.type === TURN_EVENT_TRANSPORT_TYPE
      ? createTurnEventTransportEnvelope(value.event)
      : createTurnWebSocketFrame(value.type, value)
    socket.send(JSON.stringify(frame))
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

async function drainTurnSubscription({
  subscription,
  userId,
  deliver,
  listEvents,
  isActive = () => subscription.active !== false,
}) {
  let events
  do {
    if (!isActive()) return
    try {
      events = await listEvents({
        userId,
        sessionId: subscription.sessionId,
        turnId: subscription.turnId,
        after: subscription.cursor,
        limit: TURN_EVENT_PAGE_LIMIT,
      })
    } catch (error) {
      if (!isActive()) return
      throw error
    }
    if (!isActive()) return
    if (!Array.isArray(events)) {
      throw new TypeError('Turn event source must return an array or Promise<array>')
    }
    for (const event of events) {
      if (!isActive()) return
      deliver(subscription, event)
    }
  } while (events.length === TURN_EVENT_PAGE_LIMIT)
}

export async function pollTurnSubscriptions({
  subscriptions,
  userId,
  deliver,
  listEvents = listTurnEvents,
  onError = (error, subscription) => console.error(
    `[realtime] failed to poll turn ${subscription.turnId}:`,
    error?.stack || error,
  ),
}) {
  const snapshot = [...subscriptions.values()]
  await Promise.all(snapshot.map(async (subscription) => {
    try {
      if (typeof subscription.drainDurableEvents === 'function') {
        await subscription.drainDurableEvents()
      } else {
        await drainTurnSubscription({
          subscription,
          userId,
          deliver,
          listEvents,
          isActive: () => subscription.active !== false
            && [...subscriptions.values()].includes(subscription),
        })
      }
    } catch (error) {
      onError?.(error, subscription)
    }
  }))
}

export async function subscribeTurnSubscription({
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
  onError = null,
}) {
  const previous = subscriptions.get(key)
  previous?.unsubscribe()
  subscriptions.delete(key)
  let unsubscribeEvents = () => {}
  let unsubscribeActivities = () => {}
  let drainPromise = null
  const subscription = {
    sessionId,
    turnId,
    cursor: after,
    active: true,
    replaying: true,
    pending: [],
    unsubscribe: () => {
      if (!subscription.active) return
      subscription.active = false
      subscription.pending.length = 0
      try { unsubscribeEvents() } catch { /* best-effort cleanup */ }
      try { unsubscribeActivities() } catch { /* best-effort cleanup */ }
    },
  }
  const isActive = () => subscription.active && subscriptions.get(key) === subscription
  const drainDurableEvents = () => {
    if (drainPromise) return drainPromise
    const currentDrain = drainTurnSubscription({
      subscription,
      userId,
      deliver,
      listEvents,
      isActive,
    })
    drainPromise = currentDrain
    currentDrain.then(
      () => {
        if (drainPromise === currentDrain) drainPromise = null
      },
      () => {
        if (drainPromise === currentDrain) drainPromise = null
      },
    )
    return currentDrain
  }
  subscription.drainDurableEvents = drainDurableEvents
  try {
    // Subscribe before replaying the durable log. The cursor makes the
    // local callback, replay, and cross-process poll idempotent while also
    // closing the old replay/subscribe race window.
    unsubscribeEvents = subscribe(
      { userId, sessionId, turnId },
      (event) => {
        if (!isActive()) return
        if (subscription.replaying) {
          subscription.pending.push(event)
          return
        }
        void drainDurableEvents().then(() => {
          if (isActive() && event.sequence > subscription.cursor) deliver(subscription, event)
        }).catch((error) => {
          if (isActive()) onError?.(error, subscription)
        })
      },
    )
    unsubscribeActivities = subscribeActivities(
      { userId, sessionId, turnId },
      (activity) => {
        if (isActive()) deliverActivity(subscription, activity)
      },
    )
    subscriptions.set(key, subscription)
    await drainDurableEvents()
    while (isActive() && subscription.pending.length > 0) {
      const pending = subscription.pending.splice(0).sort((a, b) => a.sequence - b.sequence)
      await drainDurableEvents()
      for (const event of pending) {
        if (!isActive()) break
        if (event.sequence > subscription.cursor) deliver(subscription, event)
      }
    }
    subscription.replaying = false
    return subscription
  } catch (error) {
    try { subscription.unsubscribe() } catch { /* best-effort cleanup */ }
    if (subscriptions.get(key) === subscription) subscriptions.delete(key)
    throw error
  }
}

export function attachTurnWebSocketServer(server, {
  isRuntimeReady = () => true,
  getRuntimeReadinessState = () => (isRuntimeReady() ? 'ready' : 'starting'),
  listEvents = listTurnEvents,
} = {}) {
  if (typeof isRuntimeReady !== 'function') {
    throw new TypeError('isRuntimeReady must be a function')
  }
  if (typeof listEvents !== 'function') {
    throw new TypeError('listEvents must be a function')
  }
  if (typeof getRuntimeReadinessState !== 'function') {
    throw new TypeError('getRuntimeReadinessState must be a function')
  }
  const webSocketServer = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    if (!isRuntimeReady()) {
      const state = getRuntimeReadinessState()
      const body = JSON.stringify({
        ok: false,
        error: {
          code: 'RUNTIME_NOT_READY',
          message: runtimeNotReadyMessage(state),
        },
      })
      const response = (
        'HTTP/1.1 503 Service Unavailable\r\n'
        + 'Connection: close\r\n'
        + 'Content-Type: application/json; charset=utf-8\r\n'
        + 'Cache-Control: no-store\r\n'
        + 'Retry-After: 1\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
        + body
      )
      try {
        socket.end(response)
      } catch {
        socket.destroy()
      }
      return
    }
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname !== '/api/realtime') return
    if (isHttpServerDraining(server)) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\n\r\n')
      socket.destroy()
      return
    }
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
      const expectedSequence = subscription.cursor + 1
      if (!canAdvanceTurnEventCursor(event, subscription.cursor)) {
        throw new TurnEventSequenceGapError({
          userId: request.userId,
          sessionId: subscription.sessionId,
          turnId: subscription.turnId,
          expectedSequence,
          actualSequence: event.sequence,
        })
      }
      subscription.cursor = event.sequence
      send(socket, { type: 'turn.event', event: turnEventForClient(event) })
    }
    const deliverActivity = (_subscription, activity) => {
      if (activity) send(socket, { type: 'turn.activity', activity })
    }
    const failSubscription = (error, subscription, { fallbackCode, fallbackMessage }) => {
      const hostUnavailable = describeTurnEngineHostUnavailableError(error)
      if (hostUnavailable) {
        try { subscription?.unsubscribe() } catch { /* best-effort cleanup */ }
        for (const [key, current] of subscriptions) {
          if (current === subscription) subscriptions.delete(key)
        }
      }
      send(socket, {
        type: 'error',
        ...(hostUnavailable?.error || {
          code: error?.code || fallbackCode,
          message: error?.message || fallbackMessage,
        }),
        sessionId: subscription.sessionId,
        turnId: subscription.turnId,
      })
      try { socket.close(1011, 'Turn subscription failed') } catch { /* already closed */ }
    }
    let pollInFlight = false
    const pollSubscriptions = () => {
      if (pollInFlight) return
      pollInFlight = true
      void pollTurnSubscriptions({
        subscriptions,
        userId: request.userId,
        deliver,
        listEvents,
        onError: (error, subscription) => {
          failSubscription(error, subscription, {
            fallbackCode: 'TURN_SUBSCRIPTION_POLL_FAILED',
            fallbackMessage: 'Turn subscription poll failed',
          })
        },
      }).catch((error) => {
        console.error('[realtime] failed to poll turn subscriptions:', error?.stack || error)
      }).finally(() => {
        pollInFlight = false
      })
    }
    const pollTimer = setInterval(pollSubscriptions, CROSS_PROCESS_POLL_MS)
    pollTimer.unref?.()
    const clearSubscriptions = () => {
      clearInterval(pollTimer)
      for (const subscription of subscriptions.values()) subscription.unsubscribe()
      subscriptions.clear()
    }
    send(socket, { type: 'ready' })

    socket.on('message', async (raw) => {
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
          const subscription = await subscribeTurnSubscription({
            subscriptions,
            key,
            userId: request.userId,
            sessionId,
            turnId,
            after,
            deliver,
            deliverActivity,
            listEvents,
            onError: (error, failedSubscription) => {
              failSubscription(error, failedSubscription, {
                fallbackCode: 'TURN_SUBSCRIBE_FAILED',
                fallbackMessage: 'Turn subscription failed',
              })
            },
          })
          if (!subscription.active || subscriptions.get(key) !== subscription) return
        } catch (error) {
          console.error(`[realtime] failed to subscribe turn ${turnId}:`, error?.stack || error)
          const hostUnavailable = describeTurnEngineHostUnavailableError(error)
          send(socket, {
            type: 'error',
            ...(hostUnavailable?.error || { code: 'TURN_SUBSCRIBE_FAILED' }),
            sessionId,
            turnId,
          })
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
