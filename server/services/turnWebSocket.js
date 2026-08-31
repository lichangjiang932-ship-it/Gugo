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
import {
  normalizeArtifactIds,
  normalizeTaskVerificationDetails,
  publicIncompleteText,
} from './turnTerminalProjection.js'
import {
  excludeVerifiedLocalFiles,
  mergeLocalFileReceipts,
} from './turnRecoveryProjection.js'
import { mergeFailedRetryEvidence } from './turnFailedRetryRejection.js'

const VALID_DECISIONS = new Set(['approve', 'deny', 'edit'])
const CROSS_PROCESS_POLL_MS = 1_000
const TURN_EVENT_PAGE_LIMIT = 2_000
const MAX_CLIENT_FRAME_BYTES = 1024 * 1024
const MAX_SUBSCRIPTIONS_PER_SOCKET = 32
const MAX_SOCKET_BUFFERED_BYTES = 1024 * 1024
const MESSAGE_RATE_CAPACITY = 64
const MESSAGE_RATE_REFILL_PER_SECOND = 32

function publicTurnFailureFrameFields(error) {
  const source = error && typeof error === 'object' ? error : {}
  const errorChain = []
  const visitedErrors = new Set()
  let currentError = source
  while (currentError && typeof currentError === 'object'
    && !visitedErrors.has(currentError) && errorChain.length < 8) {
    visitedErrors.add(currentError)
    errorChain.push(currentError)
    currentError = currentError.cause
  }
  const evidence = mergeFailedRetryEvidence(...errorChain)
  const explicitStatus = Number(source.status ?? source.statusCode)
  const recovery = source.recovery && typeof source.recovery === 'object' && !Array.isArray(source.recovery)
    ? {
        status: String(source.recovery.status || 'dead_letter'),
        retryable: source.recovery.retryable === true,
        manualRetryable: source.recovery.manualRetryable === true
          || source.recovery.status === 'dead_letter',
        ...(Number.isInteger(source.recovery.attemptCount)
          ? { attemptCount: source.recovery.attemptCount }
          : {}),
        error: {
          code: String(source.recovery.error?.code
            || source.recovery.errorCode
            || source.code
            || 'TURN_RECOVERY_BLOCKED'),
        },
      }
    : null
  const missingRequirements = [...new Set((Array.isArray(evidence.missingRequirements)
    ? evidence.missingRequirements
    : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 16)
  const taskVerification = normalizeTaskVerificationDetails(evidence.taskVerification)
  const rawNextAction = String(evidence.nextAction || errorChain
    .map((entry) => entry?.nextAction || entry?.error?.nextAction)
    .find(Boolean) || '').trim().toLowerCase().slice(0, 80)
  const nextAction = /^[a-z][a-z0-9_]{0,79}$/u.test(rawNextAction) ? rawNextAction : ''
  const verifiedLocalFiles = mergeLocalFileReceipts(evidence.verifiedLocalFiles).slice(0, 128)
  const retainedLocalFiles = excludeVerifiedLocalFiles(
    mergeLocalFileReceipts(evidence.retainedLocalFiles),
    verifiedLocalFiles,
  ).slice(0, 128)
  const iterations = Number(evidence.iterations)
  return {
    ...(Number.isInteger(explicitStatus) && explicitStatus >= 100 && explicitStatus <= 599
      ? { status: explicitStatus }
      : {}),
    ...(Number.isInteger(source.expectedSequence) && source.expectedSequence >= 0
      ? { expectedSequence: source.expectedSequence }
      : {}),
    ...(Number.isInteger(source.actualSequence) && source.actualSequence >= 0
      ? { actualSequence: source.actualSequence }
      : {}),
    ...(typeof source.retryable === 'boolean' ? { retryable: source.retryable } : {}),
    ...(typeof source.manualRetryable === 'boolean' ? { manualRetryable: source.manualRetryable } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(String(evidence.incompleteReason || '').trim()
      ? { incompleteReason: String(evidence.incompleteReason).trim() }
      : {}),
    ...(missingRequirements.length > 0 ? { missingRequirements } : {}),
    ...(taskVerification ? { taskVerification } : {}),
    ...(Number.isInteger(source.attempts) && source.attempts > 0 ? { attempts: source.attempts } : {}),
    ...(recovery ? { recovery } : {}),
    ...(Object.hasOwn(evidence, 'partialText')
      ? { partialText: publicIncompleteText(evidence.partialText, '') }
      : {}),
    ...(Object.hasOwn(evidence, 'artifactIds')
      ? { artifactIds: normalizeArtifactIds(evidence.artifactIds).slice(0, 64) }
      : {}),
    ...(Object.hasOwn(evidence, 'deliveryArtifactIds')
      ? { deliveryArtifactIds: normalizeArtifactIds(evidence.deliveryArtifactIds).slice(0, 64) }
      : {}),
    ...(Object.hasOwn(evidence, 'verifiedLocalFiles') ? { verifiedLocalFiles } : {}),
    ...(Object.hasOwn(evidence, 'retainedLocalFiles') ? { retainedLocalFiles } : {}),
    ...(Number.isInteger(iterations) && iterations >= 0 ? { iterations } : {}),
  }
}

function closeSocket(socket, code, reason) {
  if (![socket.OPEN, socket.CONNECTING].includes(socket.readyState)) return
  try { socket.close(code, reason) } catch { /* already closed */ }
}

function send(socket, value, { maxBufferedBytes = MAX_SOCKET_BUFFERED_BYTES } = {}) {
  if (socket.readyState !== socket.OPEN) return false
  const frame = value.type === TURN_EVENT_TRANSPORT_TYPE
    ? createTurnEventTransportEnvelope(value.event)
    : createTurnWebSocketFrame(value.type, value)
  const payload = JSON.stringify(frame)
  const queuedBytes = Math.max(0, Number(socket.bufferedAmount) || 0)
  if (queuedBytes + Buffer.byteLength(payload) > maxBufferedBytes) {
    closeSocket(socket, 1013, 'Realtime client is too slow')
    return false
  }
  try {
    socket.send(payload, (error) => {
      if (error) closeSocket(socket, 1011, 'Realtime send failed')
    })
    return true
  } catch {
    closeSocket(socket, 1011, 'Realtime send failed')
    return false
  }
}

function tokenFromRequest(request) {
  const protocols = String(request.headers['sec-websocket-protocol'] || '')
    .split(',').map((value) => value.trim())
    .filter(Boolean)
  if (!protocols.includes('gugo.realtime')) return null
  const bearer = protocols.filter((value) => value.startsWith('bearer.'))
  if (bearer.length !== 1) return null
  const token = bearer[0].slice(7)
  return token && token.length <= 512 ? token : null
}

function loopbackHostname(hostname) {
  const value = String(hostname || '').replace(/^\[|\]$/gu, '').toLowerCase()
  return value === '::1' || value === 'localhost' || value.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/u.test(value)
}

export function isAllowedTurnWebSocketOrigin(request) {
  const rawOrigin = String(request?.headers?.origin || '').trim()
  if (!rawOrigin) return true
  if (rawOrigin.includes(',')) return false
  const rawHost = String(request?.headers?.host || '').trim()
  if (!rawHost) return false
  let origin
  let requestUrl
  try {
    origin = new URL(rawOrigin)
    requestUrl = new URL(`http://${rawHost}`)
  } catch {
    return false
  }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) return false
  if (origin.host.toLowerCase() === requestUrl.host.toLowerCase()) return true
  return loopbackHostname(origin.hostname) && loopbackHostname(requestUrl.hostname)
}

export function createTurnWebSocketRateLimiter({
  capacity = MESSAGE_RATE_CAPACITY,
  refillPerSecond = MESSAGE_RATE_REFILL_PER_SECOND,
  now = Date.now,
} = {}) {
  const maximum = Math.max(1, Number(capacity) || MESSAGE_RATE_CAPACITY)
  const refill = Math.max(0, Number(refillPerSecond) || 0)
  let available = maximum
  let lastRefill = Number(now()) || 0
  return Object.freeze({
    take() {
      const current = Number(now()) || lastRefill
      const elapsedMs = Math.max(0, current - lastRefill)
      lastRefill = current
      available = Math.min(maximum, available + (elapsedMs * refill / 1000))
      if (available < 1) return false
      available -= 1
      return true
    },
  })
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
    pending: false,
    unsubscribe: () => {
      if (!subscription.active) return
      subscription.active = false
      subscription.pending = false
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
          subscription.pending = true
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
    while (isActive() && subscription.pending) {
      subscription.pending = false
      await drainDurableEvents()
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
  maxPayload = MAX_CLIENT_FRAME_BYTES,
  maxSubscriptions = MAX_SUBSCRIPTIONS_PER_SOCKET,
  maxBufferedBytes = MAX_SOCKET_BUFFERED_BYTES,
  messageRateCapacity = MESSAGE_RATE_CAPACITY,
  messageRateRefillPerSecond = MESSAGE_RATE_REFILL_PER_SECOND,
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
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: Math.max(1, Number(maxPayload) || MAX_CLIENT_FRAME_BYTES),
    handleProtocols: (protocols) => protocols.has('gugo.realtime') ? 'gugo.realtime' : false,
  })

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
    if (!isAllowedTurnWebSocketOrigin(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (url.searchParams.has('token')) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
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
    const subscriptionLimit = Math.max(1, Number(maxSubscriptions) || MAX_SUBSCRIPTIONS_PER_SOCKET)
    const rateLimiter = createTurnWebSocketRateLimiter({
      capacity: messageRateCapacity,
      refillPerSecond: messageRateRefillPerSecond,
    })
    const sendFrame = (value) => send(socket, value, { maxBufferedBytes })
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
      sendFrame({ type: 'turn.event', event: turnEventForClient(event) })
    }
    const deliverActivity = (_subscription, activity) => {
      if (activity) sendFrame({ type: 'turn.activity', activity })
    }
    const failSubscription = (error, subscription, { fallbackCode }) => {
      const hostUnavailable = describeTurnEngineHostUnavailableError(error)
      if (hostUnavailable) {
        try { subscription?.unsubscribe() } catch { /* best-effort cleanup */ }
        for (const [key, current] of subscriptions) {
          if (current === subscription) subscriptions.delete(key)
        }
      }
      sendFrame({
        type: 'error',
        code: hostUnavailable?.error?.code || error?.code || fallbackCode,
        ...(hostUnavailable?.error?.action ? { action: hostUnavailable.error.action } : {}),
        ...publicTurnFailureFrameFields(error),
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
    let connectionClosed = false
    const clearSubscriptions = () => {
      if (connectionClosed) return
      connectionClosed = true
      clearInterval(pollTimer)
      for (const subscription of subscriptions.values()) subscription.unsubscribe()
      subscriptions.clear()
    }
    sendFrame({ type: 'ready' })

    const handleClientMessage = async (raw) => {
      if (connectionClosed || socket.readyState !== socket.OPEN) return
      const validation = parseTurnWebSocketClientFrame(raw, { userId: request.userId })
      if (!validation.ok) {
        sendFrame({
          type: 'error',
          code: validation.code,
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
          sendFrame({ type: 'error', code: 'TURN_TARGET_REQUIRED' })
          return
        }
        const key = `${sessionId}\u0000${turnId}`
        if (!subscriptions.has(key) && subscriptions.size >= subscriptionLimit) {
          sendFrame({ type: 'error', code: 'TURN_SUBSCRIPTION_LIMIT' })
          closeSocket(socket, 1008, 'Too many turn subscriptions')
          return
        }
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
              })
            },
          })
          if (!subscription.active || subscriptions.get(key) !== subscription) return
        } catch (error) {
          console.error(`[realtime] failed to subscribe turn ${turnId}:`, error?.stack || error)
          const hostUnavailable = describeTurnEngineHostUnavailableError(error)
          sendFrame({
            type: 'error',
            code: hostUnavailable?.error?.code || error?.code || 'TURN_SUBSCRIBE_FAILED',
            ...(hostUnavailable?.error?.action ? { action: hostUnavailable.error.action } : {}),
            ...publicTurnFailureFrameFields(error),
            sessionId,
            turnId,
          })
          try { socket.close(1011, 'Turn subscription failed') } catch { /* already closed */ }
          return
        }
        sendFrame({ type: 'subscribed.turn', sessionId, turnId })
        return
      }
      if (message?.type === 'approval.decide') {
        const id = String(message.approvalId || '')
        const decision = String(message.decision || '')
        if (!id || !VALID_DECISIONS.has(decision)) {
          sendFrame({ type: 'error', code: 'INVALID_APPROVAL_DECISION' })
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
          sendFrame({ type: 'approval.resolved', approvalId: id, result })
        } catch (error) {
          sendFrame({
            type: 'error',
            code: error?.code || 'APPROVAL_DECISION_FAILED',
          })
        }
      }
    }
    let messageChain = Promise.resolve()
    socket.on('message', (raw, isBinary) => {
      if (connectionClosed) return
      if (isBinary) {
        closeSocket(socket, 1003, 'Binary realtime frames are not supported')
        return
      }
      if (!rateLimiter.take()) {
        closeSocket(socket, 1008, 'Realtime message rate exceeded')
        return
      }
      messageChain = messageChain
        .then(() => handleClientMessage(raw))
        .catch((error) => {
          console.error('[realtime] failed to process client frame:', error?.stack || error)
          sendFrame({ type: 'error', code: 'REALTIME_FRAME_PROCESSING_FAILED' })
          closeSocket(socket, 1011, 'Realtime frame processing failed')
        })
    })
    socket.on('close', clearSubscriptions)
    socket.on('error', clearSubscriptions)
  })

  server.once('close', () => webSocketServer.close())
  return webSocketServer
}

export const _turnWebSocketInternals = Object.freeze({
  MAX_CLIENT_FRAME_BYTES,
  MAX_SOCKET_BUFFERED_BYTES,
  MAX_SUBSCRIPTIONS_PER_SOCKET,
  send,
  tokenFromRequest,
})
