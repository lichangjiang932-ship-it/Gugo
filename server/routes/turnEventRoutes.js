import { authenticateRequest } from '../middleware.js'
import { resolveAuthMode } from '../adapters/authAccount.js'
import { readJson, sendJson } from '../utils.js'
import { logWarn } from '../utils/logger.js'
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
  normalizeArtifactIds,
  normalizeTaskVerificationDetails,
  publicIncompleteText,
} from '../services/turnTerminalProjection.js'
import {
  excludeVerifiedLocalFiles,
  mergeLocalFileReceipts,
} from '../services/turnRecoveryProjection.js'
import { mergeFailedRetryEvidence } from '../services/turnFailedRetryRejection.js'
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

function stablePublicFailureRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const failure = { ...value }
  for (const field of ['message', 'hint', 'reason']) delete failure[field]
  if (failure.error && typeof failure.error === 'object' && !Array.isArray(failure.error)) {
    failure.error = stablePublicFailureRecord(failure.error)
  } else if (Object.hasOwn(failure, 'error')) {
    delete failure.error
  }
  if (failure.cause && typeof failure.cause === 'object' && !Array.isArray(failure.cause)) {
    failure.cause = stablePublicFailureRecord(failure.cause)
  } else if (Object.hasOwn(failure, 'cause')) {
    delete failure.cause
  }
  if (failure.recovery && typeof failure.recovery === 'object' && !Array.isArray(failure.recovery)) {
    const recovery = { ...failure.recovery }
    for (const field of ['message', 'hint', 'reason', 'errorMessage']) delete recovery[field]
    if (recovery.error && typeof recovery.error === 'object' && !Array.isArray(recovery.error)) {
      recovery.error = stablePublicFailureRecord(recovery.error)
    } else if (Object.hasOwn(recovery, 'error')) {
      delete recovery.error
    }
    if (recovery.cause && typeof recovery.cause === 'object' && !Array.isArray(recovery.cause)) {
      recovery.cause = stablePublicFailureRecord(recovery.cause)
    } else if (Object.hasOwn(recovery, 'cause')) {
      delete recovery.cause
    }
    failure.recovery = recovery
  }
  return failure
}

function publicTurnErrorProjection(error) {
  const errorFields = error && typeof error === 'object' ? error : {}
  const errorChain = []
  const visitedErrors = new Set()
  let currentError = errorFields
  while (currentError && typeof currentError === 'object'
    && !visitedErrors.has(currentError) && errorChain.length < 8) {
    visitedErrors.add(currentError)
    errorChain.push(currentError)
    currentError = currentError.cause
  }
  const evidence = mergeFailedRetryEvidence(...errorChain)
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
  const missingRequirements = [...new Set((Array.isArray(evidence.missingRequirements)
    ? evidence.missingRequirements
    : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 16)
  const taskVerification = normalizeTaskVerificationDetails(evidence.taskVerification)
  const rawNextAction = String(evidence.nextAction || errorChain
    .map((entry) => entry?.nextAction || entry?.error?.nextAction)
    .find(Boolean) || '').trim().toLowerCase().slice(0, 80)
  const nextAction = /^[a-z][a-z0-9_]{0,79}$/u.test(rawNextAction) ? rawNextAction : ''
  const hasPartialText = Object.hasOwn(evidence, 'partialText')
  const hasArtifactIds = Object.hasOwn(evidence, 'artifactIds')
  const hasDeliveryArtifactIds = Object.hasOwn(evidence, 'deliveryArtifactIds')
  const hasVerifiedLocalFiles = Object.hasOwn(evidence, 'verifiedLocalFiles')
  const hasRetainedLocalFiles = Object.hasOwn(evidence, 'retainedLocalFiles')
  const partialText = publicIncompleteText(evidence.partialText, '')
  const artifactIds = normalizeArtifactIds(evidence.artifactIds).slice(0, 64)
  const deliveryArtifactIds = normalizeArtifactIds(evidence.deliveryArtifactIds).slice(0, 64)
  const verifiedLocalFiles = mergeLocalFileReceipts(evidence.verifiedLocalFiles)
  const retainedLocalFiles = excludeVerifiedLocalFiles(
    mergeLocalFileReceipts(evidence.retainedLocalFiles),
    verifiedLocalFiles,
  )
  const iterations = Number(evidence.iterations)
  const payload = {
    error: {
      ...(readiness || (hostUnavailable
        ? hostUnavailable.error
        : {
            code: error?.code || 'INVALID_TURN_REQUEST',
            message: error?.message || String(error),
          })),
      ...(Number.isInteger(error?.expectedSequence) ? { expectedSequence: error.expectedSequence } : {}),
      ...(Number.isInteger(error?.actualSequence) ? { actualSequence: error.actualSequence } : {}),
      ...(typeof error?.retryable === 'boolean' ? { retryable: error.retryable } : {}),
      ...(typeof error?.manualRetryable === 'boolean' ? { manualRetryable: error.manualRetryable } : {}),
      ...(nextAction ? { nextAction } : {}),
      ...(String(evidence.incompleteReason || '').trim()
        ? { incompleteReason: String(evidence.incompleteReason).trim() }
        : {}),
      ...(missingRequirements.length > 0 ? { missingRequirements } : {}),
      ...(taskVerification ? { taskVerification } : {}),
      ...(Number.isInteger(error?.attempts) && error.attempts > 0 ? { attempts: error.attempts } : {}),
      ...(recovery ? { recovery } : {}),
    },
    ...(hasPartialText ? { partialText } : {}),
    ...(hasArtifactIds ? { artifactIds } : {}),
    ...(hasDeliveryArtifactIds ? { deliveryArtifactIds } : {}),
    ...(hasVerifiedLocalFiles ? { verifiedLocalFiles } : {}),
    ...(hasRetainedLocalFiles ? { retainedLocalFiles } : {}),
    ...(Number.isInteger(iterations) && iterations >= 0 ? { iterations } : {}),
  }
  return {
    status,
    payload: stablePublicFailureRecord(payload),
  }
}

function sendError(res, error) {
  const projected = publicTurnErrorProjection(error)
  return sendJson(res, projected.status, projected.payload)
}

function createTurnRouteRuntime(engine, resolveEngine) {
  let activeEngine = engine
  const requireEngine = () => {
    if (!activeEngine) activeEngine = resolveEngine()
    return activeEngine
  }
  return {
    requireEngine,
    readTurnEvents(options) {
      const selectedEngine = requireEngine()
      return typeof selectedEngine?.listEvents === 'function'
        ? selectedEngine.listEvents(options)
        : listTurnEvents(options)
    },
  }
}

function handleTurnWriteFailureRoute(req, res, url, parts, userId) {
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
  if (parts[0] !== 'api' || parts[1] !== 'turns'
    || parts[2] !== 'event-write-failures' || !parts[3] || parts.length < 4) return null
  const failureId = decodeURIComponent(parts[3])
  if (req.method === 'POST' && parts[4] === 'replay' && parts.length === 5) {
    const replayed = replayTurnEventWriteFailure({ userId, id: failureId })
    return replayed
      ? sendJson(res, 200, { replayed })
      : sendJson(res, 404, {
          error: {
            code: 'TURN_EVENT_WRITE_FAILURE_NOT_FOUND',
            message: 'event write failure not found',
          },
        })
  }
  if (req.method === 'DELETE' && parts.length === 4) {
    const acknowledged = acknowledgeTurnEventWriteFailure({ userId, id: failureId })
    return acknowledged
      ? sendJson(res, 200, { acknowledged: true })
      : sendJson(res, 404, {
          error: {
            code: 'TURN_EVENT_WRITE_FAILURE_NOT_FOUND',
            message: 'event write failure not found',
          },
        })
  }
  return null
}

async function openTurnEventStream(req, res, url, runtime, userId) {
  const sessionId = url.searchParams.get('sessionId')
  const turnId = url.searchParams.get('turnId')
  if (!sessionId || !turnId) {
    return sendJson(res, 400, {
      error: { code: 'TURN_STREAM_TARGET_REQUIRED', message: 'sessionId and turnId are required' },
    })
  }
  const versionRequested = url.searchParams.has(TURN_EVENT_TRANSPORT_QUERY_PARAM)
  const requestedVersion = url.searchParams.get(TURN_EVENT_TRANSPORT_QUERY_PARAM)
  if (versionRequested && requestedVersion !== String(TURN_EVENT_TRANSPORT_VERSION)) {
    return sendJson(res, 400, {
      error: {
        code: 'TURN_EVENT_TRANSPORT_VERSION_UNSUPPORTED',
        message: `Turn event transport v${TURN_EVENT_TRANSPORT_VERSION} is required`,
        expectedVersion: TURN_EVENT_TRANSPORT_VERSION,
        receivedVersion: requestedVersion,
      },
    })
  }
  const state = {
    lastSequence: parseAfter(url.searchParams.get('after')),
    replaying: true,
    closed: false,
    pending: [],
    pendingActivities: [],
    heartbeat: null,
    databasePoll: null,
    pollQueued: false,
    deliveryTail: Promise.resolve(),
    unsubscribeEvents: () => {},
    unsubscribeActivities: () => {},
  }
  const cleanup = () => {
    if (state.closed) return
    state.closed = true
    if (state.heartbeat) clearInterval(state.heartbeat)
    if (state.databasePoll) clearInterval(state.databasePoll)
    state.unsubscribeEvents()
    state.unsubscribeActivities()
  }
  const failStream = async (error) => {
    if (state.closed) return
    try {
      const projected = publicTurnErrorProjection(error)
      await sendSse(res, 'error', projected.payload)
    } finally {
      cleanup()
      if (!res.writableEnded) res.end()
    }
  }
  const sendEvent = async (event) => {
    if (state.closed || event.sequence <= state.lastSequence) return false
    const expectedSequence = state.lastSequence + 1
    if (!canAdvanceTurnEventCursor(event, state.lastSequence)) {
      throw new TurnEventSequenceGapError({
        userId, sessionId, turnId, expectedSequence, actualSequence: event.sequence,
      })
    }
    const clientEvent = turnEventForClient(event)
    const payload = versionRequested ? createTurnEventTransportEnvelope(clientEvent) : clientEvent
    await sendSse(res, 'turn_event', payload, event.sequence)
    if (state.closed) return false
    state.lastSequence = event.sequence
    if (STREAM_END_EVENTS.has(event.type)) {
      cleanup()
      res.end()
    }
    return true
  }
  const sendActivity = async (activity) => {
    if (!state.closed) await sendSse(res, 'turn_activity', activity)
  }
  const drainDurableEvents = async () => {
    let page
    do {
      page = await runtime.readTurnEvents({
        userId, sessionId, turnId, after: state.lastSequence, limit: 2000,
      })
      for (const event of page) {
        await sendEvent(event)
        if (state.closed) break
      }
    } while (!state.closed && page.length === 2000)
  }
  const queueDelivery = (operation) => {
    const queued = state.deliveryTail.then(operation)
    state.deliveryTail = queued.catch(failStream)
    return queued
  }
  state.unsubscribeEvents = subscribeTurnEvents({ userId, sessionId, turnId }, (event) => {
    if (state.replaying) state.pending.push(event)
    else {
      queueDelivery(async () => {
        if (state.closed || event.sequence <= state.lastSequence) return
        await drainDurableEvents()
        if (!state.closed && event.sequence > state.lastSequence) await sendEvent(event)
      }).catch(() => {})
    }
  })
  state.unsubscribeActivities = subscribeTurnActivities({ userId, sessionId, turnId }, (activity) => {
    if (state.replaying) state.pendingActivities.push(activity)
    else queueDelivery(() => sendActivity(activity)).catch(() => {})
  })
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(versionRequested
      ? { 'X-Gugo-Turn-Event-Version': String(TURN_EVENT_TRANSPORT_VERSION) }
      : {}),
  })
  res.flushHeaders?.()
  res.write('retry: 1000\n\n')
  req.on('close', cleanup)
  res.on?.('close', cleanup)
  try {
    await sendSse(res, 'ready', { phase: 'connecting', after: state.lastSequence })
    await drainDurableEvents()
    while (!state.closed && state.pending.length > 0) {
      const buffered = state.pending.splice(0).sort((a, b) => a.sequence - b.sequence)
      await drainDurableEvents()
      for (const event of buffered) {
        if (event.sequence <= state.lastSequence) continue
        await drainDurableEvents()
        if (!state.closed && event.sequence > state.lastSequence) await sendEvent(event)
      }
    }
    state.replaying = false
    for (const activity of state.pendingActivities.splice(0)) await sendActivity(activity)
  } catch (error) {
    await failStream(error)
  }
  if (!state.closed) {
    state.databasePoll = setInterval(() => {
      if (state.closed || state.pollQueued) return
      state.pollQueued = true
      queueDelivery(drainDurableEvents).catch(() => {}).finally(() => { state.pollQueued = false })
    }, resolveTurnEventStreamPollInterval(runtime.env))
    state.databasePoll.unref?.()
    state.heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n')
    }, 15_000)
    state.heartbeat.unref?.()
  }
  return undefined
}

async function handleTurnCollection(req, res, url, runtime, userId) {
  if (req.method === 'GET' && url.pathname === '/api/turns/events') {
    const events = await runtime.readTurnEvents({
      userId,
      sessionId: url.searchParams.get('sessionId'),
      turnId: url.searchParams.get('turnId'),
      after: url.searchParams.get('after'),
      limit: url.searchParams.get('limit'),
    })
    return sendJson(res, 200, { events: events.map(turnEventForClient) })
  }
  if (req.method === 'POST' && url.pathname === '/api/turns/run') {
    const body = await readJson(req, { maxBytes: MAX_TURN_RUN_BODY_BYTES })
    const turn = await runtime.requireEngine().startTurn({
      userId,
      sessionId: body.sessionId,
      turnId: body.turnId || undefined,
      content: body.content,
      displayContent: body.displayContent,
      workspacePath: body.workspacePath,
      locale: body.locale,
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
      authMode: resolveAuthMode(runtime.env),
    })
    return sendJson(res, 202, { turn })
  }
  return null
}

async function handleTurnResource(req, res, url, parts, runtime, userId) {
  if (parts[0] !== 'api' || parts[1] !== 'turns' || !parts[2] || parts.length < 3) return null
  const turnId = decodeURIComponent(parts[2])
  if (req.method === 'GET' && parts[3] === 'model-request-recovery' && parts.length === 4) {
    const recovery = await runtime.requireEngine().getPendingModelRequestRecovery({
      userId, sessionId: url.searchParams.get('sessionId'), turnId,
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
    const recovery = await runtime.requireEngine().resolvePendingModelRequest({
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
    return sendJson(res, 200, {
      recovery,
      resume: {
        ready: ['not_sent', 'completed'].includes(recovery.resolution),
        sessionId: body.sessionId,
        turnId,
      },
    })
  }
  if (req.method === 'GET' && parts.length === 3) {
    const turn = await runtime.requireEngine().getTurn({
      userId, sessionId: url.searchParams.get('sessionId'), turnId,
    })
    return turn
      ? sendJson(res, 200, { turn })
      : sendJson(res, 404, { error: { code: 'TURN_NOT_FOUND', message: 'turn not found' } })
  }
  if (req.method === 'POST' && parts[3] === 'steer' && parts.length === 4) {
    const body = await readJson(req)
    const steering = await runtime.requireEngine().steerTurn({
      userId,
      sessionId: body.sessionId,
      turnId,
      content: body.content,
      clientRequestId: body.clientRequestId,
      authMode: resolveAuthMode(runtime.env),
    })
    return sendJson(res, 202, { steering })
  }
  if (req.method === 'POST'
    && (parts[3] === 'cancel' || parts[3] === 'resume')
    && parts.length === 4) {
    const body = await readJson(req)
    const action = parts[3] === 'cancel' ? 'cancelTurn' : 'resumeTurn'
    const turn = await runtime.requireEngine()[action]({
      userId,
      sessionId: body.sessionId,
      turnId,
      ...(parts[3] === 'resume' ? { resolution: body.resolution ?? null } : {}),
      ...(parts[3] === 'resume' ? { retryRecovery: body.retryRecovery === true } : {}),
      ...(parts[3] === 'resume' ? { retryFailed: body.retryFailed === true } : {}),
      authMode: resolveAuthMode(runtime.env),
    })
    return sendJson(res, parts[3] === 'resume' ? 202 : 200, { turn })
  }
  return null
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
  const runtime = { ...createTurnRouteRuntime(engine, resolveEngine), env }
  try {
    const failureResponse = handleTurnWriteFailureRoute(req, res, url, parts, userId)
    if (failureResponse !== null) return failureResponse
    if (req.method === 'GET' && url.pathname === '/api/turns/stream') {
      return await openTurnEventStream(req, res, url, runtime, userId)
    }
    const collectionResponse = await handleTurnCollection(req, res, url, runtime, userId)
    if (collectionResponse !== null) return collectionResponse
    const resourceResponse = await handleTurnResource(req, res, url, parts, runtime, userId)
    if (resourceResponse !== null) return resourceResponse
    return sendJson(res, 405, {
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
    })
  } catch (error) {
    logWarn('turn.request_rejected', error, {
      method: req.method,
      pathname: url.pathname,
      code: error?.code || 'INVALID_TURN_REQUEST',
      status: error?.status ?? error?.statusCode ?? 400,
    })
    return sendError(res, error)
  }
}
