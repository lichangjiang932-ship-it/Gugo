import { authenticateRequest } from '../middleware.js'
import { resolveAuthMode } from '../adapters/authAccount.js'
import { readJson, sendJson } from '../utils.js'
import { TurnEngineError } from '../services/turnResolutionRuntime.js'
import { getTurnEngine } from '../services/turnEngineHost.js'
import { describeTurnEngineHostUnavailableError } from '../services/turnEngineHostErrorContract.js'
import {
  acknowledgeTurnEventWriteFailure,
  listTurnEvents,
  listTurnEventWriteFailures,
  replayTurnEventWriteFailure,
  subscribeTurnEvents,
  TurnEventSequenceGapError,
  turnEventForClient,
} from '../services/turnEventStore.js'
import { subscribeTurnActivities } from '../services/turnActivityBus.js'
import { TurnSteeringError } from '../services/turnSteeringStore.js'
import {
  describeModelReadinessFailure,
  isModelReadinessError,
} from '../services/modelReadinessService.js'
import {
  TURN_EVENT_TRANSPORT_QUERY_PARAM,
  TURN_EVENT_TRANSPORT_VERSION,
  canAdvanceTurnEventCursor,
  createTurnEventTransportEnvelope,
} from '../../shared/turnEvents.js'

// An interruption ends this transport attempt, but the persisted turn remains
// non-terminal so a later resume can continue from its durable checkpoint.
const STREAM_END_EVENTS = new Set([
  'turn.completed', 'turn.blocked', 'turn.paused', 'turn.cancelled', 'turn.failed', 'turn.interrupted',
])
const DEFAULT_STREAM_POLL_INTERVAL_MS = 1_000
const MIN_STREAM_POLL_INTERVAL_MS = 100
const MAX_STREAM_POLL_INTERVAL_MS = 30_000
const MAX_TURN_RUN_BODY_BYTES = 16 * 1024 * 1024
export function resolveTurnEventStreamPollInterval(env = process.env) {
  const parsed = Number(env?.TURN_EVENT_STREAM_POLL_INTERVAL_MS)
  if (!Number.isFinite(parsed)) return DEFAULT_STREAM_POLL_INTERVAL_MS
  return Math.min(MAX_STREAM_POLL_INTERVAL_MS, Math.max(MIN_STREAM_POLL_INTERVAL_MS, Math.floor(parsed)))
}

async function sendSse(res, event, data, id = null) {
  const frame = `${id !== null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  if (res.write(frame) !== false || typeof res.once !== 'function') return
  await new Promise((resolve) => {
    const finish = () => {
      res.off?.('drain', finish)
      res.off?.('close', finish)
      resolve()
    }
    res.once('drain', finish)
    res.once('close', finish)
  })
}

function parseAfter(value) {
  if (value === null || value === undefined || value === '') return -1
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.floor(parsed) : -1
}

function routeParts(pathname) {
  return pathname.split('/').filter(Boolean)
}

function sendError(res, error) {
  const explicitStatus = Number(error?.status ?? error?.statusCode)
  const hostUnavailable = describeTurnEngineHostUnavailableError(error)
  const readinessFailure = isModelReadinessError(error)
    ? describeModelReadinessFailure(error)
    : null
  const status = readinessFailure
    ? readinessFailure.statusCode
    : hostUnavailable
    ? hostUnavailable.statusCode
    : error instanceof TurnEngineError || error instanceof TurnSteeringError
    ? error.status
    : Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599
      ? explicitStatus
      : 400
  const readiness = readinessFailure?.error || null
  const recovery = error?.recovery && typeof error.recovery === 'object'
    ? {
        status: error.recovery.status || 'dead_letter',
        retryable: error.recovery.retryable === true,
        manualRetryable: error.recovery.manualRetryable === true
          || error.recovery.status === 'dead_letter',
        ...(Number.isInteger(error.recovery.attemptCount)
          ? { attemptCount: error.recovery.attemptCount }
          : {}),
        error: {
          code: error.recovery.error?.code
            || error.recovery.errorCode
            || error?.code
            || 'TURN_RECOVERY_BLOCKED',
          message: error.recovery.error?.message
            || error.recovery.errorMessage
            || error?.message
            || 'turn recovery is blocked',
        },
      }
    : null
  return sendJson(res, status, {
    error: {
      ...(readiness || (hostUnavailable
        ? hostUnavailable.error
        : {
        code: error?.code || 'INVALID_TURN_REQUEST',
        message: error?.message || String(error),
          })),
      ...(Number.isInteger(error?.expectedSequence) ? { expectedSequence: error.expectedSequence } : {}),
      ...(Number.isInteger(error?.actualSequence) ? { actualSequence: error.actualSequence } : {}),
      ...(recovery ? { recovery } : {}),
    },
  })
}

export async function handleTurnEventRequest(
  req,
  res,
  engine = null,
  { env = process.env, resolveEngine = getTurnEngine } = {},
) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
  const url = new URL(req.url, 'http://localhost')
  const parts = routeParts(url.pathname)
  let activeEngine = engine
  const requireEngine = () => {
    if (!activeEngine) activeEngine = resolveEngine()
    return activeEngine
  }
  const readTurnEvents = (options) => {
    const selectedEngine = requireEngine()
    return typeof selectedEngine?.listEvents === 'function'
      ? selectedEngine.listEvents(options)
      : listTurnEvents(options)
  }
  try {
    if (req.method === 'GET' && url.pathname === '/api/turns/event-write-failures') {
      const failures = listTurnEventWriteFailures({
        userId,
        sessionId: url.searchParams.get('sessionId'),
        turnId: url.searchParams.get('turnId'),
        beforeId: url.searchParams.get('beforeId'),
        limit: url.searchParams.get('limit'),
      })
      return sendJson(res, 200, {
        failures,
        nextBeforeId: failures.length > 0 ? failures.at(-1).id : null,
      })
    }

    if (parts[0] === 'api' && parts[1] === 'turns' && parts[2] === 'event-write-failures'
      && parts[3] && parts.length >= 4) {
      const failureId = decodeURIComponent(parts[3])
      if (req.method === 'POST' && parts[4] === 'replay' && parts.length === 5) {
        const replayed = replayTurnEventWriteFailure({ userId, id: failureId })
        return replayed
          ? sendJson(res, 200, { replayed })
          : sendJson(res, 404, { error: { code: 'TURN_EVENT_WRITE_FAILURE_NOT_FOUND', message: 'event write failure not found' } })
      }
      if (req.method === 'DELETE' && parts.length === 4) {
        const acknowledged = acknowledgeTurnEventWriteFailure({ userId, id: failureId })
        return acknowledged
          ? sendJson(res, 200, { acknowledged: true })
          : sendJson(res, 404, { error: { code: 'TURN_EVENT_WRITE_FAILURE_NOT_FOUND', message: 'event write failure not found' } })
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/turns/stream') {
      const sessionId = url.searchParams.get('sessionId')
      const turnId = url.searchParams.get('turnId')
      if (!sessionId || !turnId) {
        return sendJson(res, 400, { error: { code: 'TURN_STREAM_TARGET_REQUIRED', message: 'sessionId and turnId are required' } })
      }
      const eventVersionWasRequested = url.searchParams.has(TURN_EVENT_TRANSPORT_QUERY_PARAM)
      const requestedEventVersion = url.searchParams.get(TURN_EVENT_TRANSPORT_QUERY_PARAM)
      const useVersionedEventEnvelope = eventVersionWasRequested
      if (useVersionedEventEnvelope
        && requestedEventVersion !== String(TURN_EVENT_TRANSPORT_VERSION)) {
        return sendJson(res, 400, {
          error: {
            code: 'TURN_EVENT_TRANSPORT_VERSION_UNSUPPORTED',
            message: `Turn event transport v${TURN_EVENT_TRANSPORT_VERSION} is required`,
            expectedVersion: TURN_EVENT_TRANSPORT_VERSION,
            receivedVersion: requestedEventVersion,
          },
        })
      }

      let lastSequence = parseAfter(url.searchParams.get('after'))
      let replaying = true
      let closed = false
      const pending = []
      const pendingActivities = []
      let heartbeat = null
      let databasePoll = null
      let pollQueued = false
      let deliveryTail = Promise.resolve()
      let unsubscribeEvents = () => {}
      let unsubscribeActivities = () => {}
      const cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        if (databasePoll) clearInterval(databasePoll)
        unsubscribeEvents()
        unsubscribeActivities()
      }
      const failStream = async (error) => {
        if (closed) return
        try {
          await sendSse(res, 'error', {
            error: {
              code: error?.code || 'TURN_EVENT_STREAM_FAILED',
              message: error?.message || 'Turn event stream failed',
              ...(Number.isInteger(error?.expectedSequence) ? { expectedSequence: error.expectedSequence } : {}),
              ...(Number.isInteger(error?.actualSequence) ? { actualSequence: error.actualSequence } : {}),
            },
          })
        } finally {
          cleanup()
          if (!res.writableEnded) res.end()
        }
      }
      const sendEvent = async (event) => {
        if (closed || event.sequence <= lastSequence) return false
        const expectedSequence = lastSequence + 1
        if (!canAdvanceTurnEventCursor(event, lastSequence)) {
          throw new TurnEventSequenceGapError({
            userId,
            sessionId,
            turnId,
            expectedSequence,
            actualSequence: event.sequence,
          })
        }
        const clientEvent = turnEventForClient(event)
        const payload = useVersionedEventEnvelope
          ? createTurnEventTransportEnvelope(clientEvent)
          : clientEvent
        await sendSse(res, 'turn_event', payload, event.sequence)
        if (closed) return false
        lastSequence = event.sequence
        if (STREAM_END_EVENTS.has(event.type)) {
          cleanup()
          res.end()
        }
        return true
      }
      const sendActivity = async (activity) => {
        if (closed) return
        // Live activities are intentionally id-less and do not move the
        // durable sequence cursor used for replay/reconnect.
        await sendSse(res, 'turn_activity', activity)
      }
      const drainDurableEvents = async () => {
        let page
        do {
          page = await readTurnEvents({ userId, sessionId, turnId, after: lastSequence, limit: 2000 })
          for (const event of page) {
            await sendEvent(event)
            if (closed) break
          }
        } while (!closed && page.length === 2000)
      }
      const queueDelivery = (operation) => {
        const queued = deliveryTail.then(operation)
        deliveryTail = queued.catch(failStream)
        return queued
      }

      unsubscribeEvents = subscribeTurnEvents({ userId, sessionId, turnId }, (event) => {
        if (replaying) pending.push(event)
        else {
          queueDelivery(async () => {
            if (closed || event.sequence <= lastSequence) return
            await drainDurableEvents()
            if (!closed && event.sequence > lastSequence) await sendEvent(event)
          }).catch(() => {})
        }
      })
      unsubscribeActivities = subscribeTurnActivities({ userId, sessionId, turnId }, (activity) => {
        if (replaying) pendingActivities.push(activity)
        else queueDelivery(() => sendActivity(activity)).catch(() => {})
      })
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(useVersionedEventEnvelope
          ? { 'X-Gugo-Turn-Event-Version': String(TURN_EVENT_TRANSPORT_VERSION) }
          : {}),
      })
      res.flushHeaders?.()
      res.write('retry: 1000\n\n')
      req.on('close', cleanup)
      res.on?.('close', cleanup)
      try {
        await sendSse(res, 'ready', { phase: 'connecting', after: lastSequence })
        await drainDurableEvents()
        while (!closed && pending.length > 0) {
          const buffered = pending.splice(0).sort((a, b) => a.sequence - b.sequence)
          await drainDurableEvents()
          for (const event of buffered) {
            if (event.sequence <= lastSequence) continue
            await drainDurableEvents()
            if (!closed && event.sequence > lastSequence) await sendEvent(event)
          }
        }
        replaying = false
        for (const activity of pendingActivities.splice(0)) await sendActivity(activity)
      } catch (error) {
        await failStream(error)
      }
      if (!closed) {
        // The in-memory subscription only observes events appended by this
        // process. Polling the shared database keeps SSE streams live when a
        // different application instance owns the turn. sendEvent's sequence
        // cursor merges both sources without emitting an event twice.
        databasePoll = setInterval(() => {
          if (closed || pollQueued) return
          pollQueued = true
          queueDelivery(drainDurableEvents)
            .catch(() => {})
            .finally(() => { pollQueued = false })
        }, resolveTurnEventStreamPollInterval(env))
        databasePoll.unref?.()
        heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n')
        }, 15_000)
        heartbeat.unref?.()
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/turns/events') {
      const events = await readTurnEvents({
        userId,
        sessionId: url.searchParams.get('sessionId'),
        turnId: url.searchParams.get('turnId'),
        after: url.searchParams.get('after'),
        limit: url.searchParams.get('limit'),
      })
      return sendJson(res, 200, { events: events.map(turnEventForClient) })
    }

    if (req.method === 'POST' && url.pathname === '/api/turns/run') {
      // The first server-owned turn may import the complete legacy browser
      // transcript. Keep this endpoint larger than ordinary JSON routes while
      // retaining a finite cap against accidental or hostile payloads.
      const body = await readJson(req, { maxBytes: MAX_TURN_RUN_BODY_BYTES })
      const turn = await requireEngine().startTurn({
        userId,
        sessionId: body.sessionId,
        turnId: body.turnId || undefined,
        content: body.content,
        displayContent: body.displayContent,
        workspacePath: body.workspacePath,
        modelName: body.modelName || null,
        modelProviderId: body.modelProviderId || null,
        modelConfigRevision: body.modelConfigRevision ?? null,
        modelMode: body.modelMode,
        history: body.history,
        agentId: body.agentId || null,
        skillIds: body.skillIds,
        skillDefinitions: body.skillDefinitions,
        toolsConfig: body.toolsConfig,
        intentMode: body.intentMode,
        attachments: body.attachments,
        authMode: resolveAuthMode(env),
      })
      return sendJson(res, 202, { turn })
    }

    if (parts[0] === 'api' && parts[1] === 'turns' && parts[2] && parts.length >= 3) {
      const turnId = decodeURIComponent(parts[2])
      if (req.method === 'GET' && parts[3] === 'model-request-recovery' && parts.length === 4) {
        const recovery = await requireEngine().getPendingModelRequestRecovery({
          userId,
          sessionId: url.searchParams.get('sessionId'),
          turnId,
        })
        return recovery
          ? sendJson(res, 200, { recovery })
          : sendJson(res, 404, {
              error: {
                code: 'MODEL_REQUEST_RECOVERY_NOT_FOUND',
                message: 'model request recovery was not found',
              },
            })
      }
      if (req.method === 'POST' && parts[3] === 'model-request-recovery'
        && parts[4] === 'resolve' && parts.length === 5) {
        const body = await readJson(req)
        const recovery = await requireEngine().resolvePendingModelRequest({
          userId,
          sessionId: body.sessionId,
          turnId,
          expectedCheckpointSequence: body.checkpointSequence,
          modelRequestId: body.modelRequestId,
          requestFingerprint: body.requestFingerprint,
          providerId: body.providerId,
          modelName: body.modelName,
          configRevision: body.configRevision,
          idempotencyKey: body.idempotencyKey,
          confirmModelRequestId: body.confirmModelRequestId,
          verificationConfirmed: body.verificationConfirmed,
          resolution: body.resolution,
          response: body.response,
          receipt: body.receipt,
          note: body.note,
        })
        const ready = ['not_sent', 'completed'].includes(recovery.resolution)
        return sendJson(res, 200, {
          recovery,
          resume: {
            ready,
            sessionId: body.sessionId,
            turnId,
          },
        })
      }
      if (req.method === 'GET' && parts.length === 3) {
        const turn = await requireEngine().getTurn({
          userId,
          sessionId: url.searchParams.get('sessionId'),
          turnId,
        })
        return turn
          ? sendJson(res, 200, { turn })
          : sendJson(res, 404, { error: { code: 'TURN_NOT_FOUND', message: 'turn not found' } })
      }
      if (req.method === 'POST' && parts[3] === 'steer' && parts.length === 4) {
        const body = await readJson(req)
        const steering = await requireEngine().steerTurn({
          userId,
          sessionId: body.sessionId,
          turnId,
          content: body.content,
          clientRequestId: body.clientRequestId,
          authMode: resolveAuthMode(env),
        })
        return sendJson(res, 202, { steering })
      }
      if (req.method === 'POST' && (parts[3] === 'cancel' || parts[3] === 'resume') && parts.length === 4) {
        const body = await readJson(req)
        const action = parts[3] === 'cancel' ? 'cancelTurn' : 'resumeTurn'
        const turn = await requireEngine()[action]({
          userId,
          sessionId: body.sessionId,
          turnId,
          ...(parts[3] === 'resume' ? { resolution: body.resolution ?? null } : {}),
          ...(parts[3] === 'resume' ? { retryRecovery: body.retryRecovery === true } : {}),
          ...(parts[3] === 'resume' ? { retryFailed: body.retryFailed === true } : {}),
          authMode: resolveAuthMode(env),
        })
        return sendJson(res, parts[3] === 'resume' ? 202 : 200, { turn })
      }
    }

    return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } })
  } catch (error) {
    return sendError(res, error)
  }
}
