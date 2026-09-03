export { mergeServerSessionMessages } from './sessionMessageSnapshotMerge.js'

const SERVER_MUTATION_TYPES = new Set([
  'DELETE_SESSION',
  'CLEAR_CURRENT_SESSION',
  'DELETE_MESSAGE',
  'TRUNCATE_MESSAGES',
  'COMPRESS_CURRENT_SESSION',
  'COMPACT_SESSION',
  'EXPAND_COMPACTED',
])

const ACTIVE_SESSION_MUTATION_TYPES = new Set([
  'CLEAR_CURRENT_SESSION',
  'DELETE_MESSAGE',
  'TRUNCATE_MESSAGES',
  'COMPRESS_CURRENT_SESSION',
])

export function isServerSessionMutation(action) {
  return !!action && SERVER_MUTATION_TYPES.has(action.type)
}

export function resolveSessionMutationTarget(state, action) {
  if (!isServerSessionMutation(action)) return null
  if (action.type === 'DELETE_SESSION') {
    return typeof action.payload === 'string' ? action.payload : null
  }
  if (action.type === 'COMPACT_SESSION' || action.type === 'EXPAND_COMPACTED') {
    return action.payload?.sessionId || state?.activeSessionId || null
  }
  return state?.activeSessionId || null
}

export function isServerBackedSession(session) {
  return Number.isInteger(session?.serverRevision)
}

export function getServerSessionSnapshotWatermark(session) {
  if (!isServerBackedSession(session)) return null
  const turnEventRevision = Number(session?.serverTurnEventRevision)
  return Number.isInteger(turnEventRevision) && turnEventRevision >= 0
    ? `${session.serverRevision}:${turnEventRevision}`
    : session.serverRevision
}

function hasIncompleteTaskDiagnosticGap(message) {
  const failure = message?.meta?.serverFailure
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return false
  const code = String(failure.code || '').trim().toUpperCase()
  const incompleteReason = String(failure.incompleteReason || '').trim().toLowerCase()
  if (code !== 'TURN_INCOMPLETE' && !incompleteReason) return false
  if (!incompleteReason
    || !Array.isArray(failure.missingRequirements)
    || typeof failure.retryable !== 'boolean') return true
  if (['task_verification_repair_exhausted', 'task_verification_repair_pending'].includes(incompleteReason)) {
    const verification = failure.taskVerification
    if (!verification || typeof verification !== 'object' || !Array.isArray(verification.checks)) return true
  }
  const blocked = message?.meta?.serverConnectionState === 'blocked'
    || code === 'TURN_RECOVERY_BLOCKED'
  return blocked && typeof failure.manualRetryable !== 'boolean'
}

export function needsServerTranscriptHydration(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : []
  // Older browser records may predate serverRevision while the same session
  // already exists in the durable store. A generic TURN_INCOMPLETE card is a
  // narrow, safe reason to probe that exact session id for richer diagnostics.
  if (messages.some(hasIncompleteTaskDiagnosticGap)) return true
  if (!isServerBackedSession(session)) return false
  if (session?.serverTranscriptStale === true) return true
  return messages.length === 0
    || messages.every((message) => (
      message?.meta?.pendingServerSync === true || message?.meta?.streaming === true
    ))
}

export function needsServerSessionSnapshot(session, hydratedRevision) {
  return needsServerTranscriptHydration(session)
    && (!isServerBackedSession(session)
      || hydratedRevision !== getServerSessionSnapshotWatermark(session))
}

function normalizedMessageContent(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function sameSessionTranscript(serverMessages, projectedMessages) {
  if (!Array.isArray(serverMessages) || !Array.isArray(projectedMessages)) return false
  if (serverMessages.length !== projectedMessages.length) return false
  return serverMessages.every((serverMessage, index) => {
    const projectedMessage = projectedMessages[index]
    return String(serverMessage?.id || '') === String(projectedMessage?.id || '')
      && String(serverMessage?.role || '') === String(projectedMessage?.role || '')
      && normalizedMessageContent(serverMessage?.content)
        === normalizedMessageContent(projectedMessage?.content)
  })
}

function canConfirmReplacementAfterError(error) {
  return error?.status === 409
    || error?.status === 500
    || error?.code === 'SESSION_REVISION_CONFLICT'
    || error?.code === 'SESSION_ADMIN_RESULT_INVALID'
}

function bindActionToSession(action, sessionId) {
  if (action.type !== 'COMPACT_SESSION' && action.type !== 'EXPAND_COMPACTED') return action
  return {
    ...action,
    payload: {
      ...(action.payload || {}),
      sessionId,
    },
  }
}

export function projectSessionMutation({ state, action, sessionId, reduceState }) {
  const session = state?.sessions?.find((candidate) => candidate.id === sessionId)
  if (!session || !isServerBackedSession(session)) return null
  if (action.type === 'DELETE_SESSION') {
    return {
      kind: 'delete',
      sessionId,
      expectedRevision: session.serverRevision,
    }
  }

  const projectionState = ACTIVE_SESSION_MUTATION_TYPES.has(action.type)
    ? { ...state, activeSessionId: sessionId }
    : state
  const projectedState = reduceState(projectionState, bindActionToSession(action, sessionId))
  const projectedSession = projectedState?.sessions?.find((candidate) => candidate.id === sessionId)
  if (!projectedSession || projectedSession.messages === session.messages) return null
  return {
    kind: 'replace',
    sessionId,
    expectedRevision: session.serverRevision,
    sourceMessages: session.messages,
    messages: projectedSession.messages,
  }
}

export function createSessionMutationDispatcher({
  getState,
  reduceState,
  dispatchImmediate,
  applyServerAction,
  replaceMessages,
  deleteSession,
  canFetchSessionSnapshot = () => true,
  fetchSessionSnapshot = null,
  resolveSessionMetadata = null,
  onError = () => {},
}) {
  const queues = new Map()
  const snapshotRequests = new Map()
  const hydratedRevisions = new Map()

  const applyCompleteSessionSnapshot = (sessionId, snapshot) => {
    if (snapshot?.complete !== true || !Array.isArray(snapshot.messages) || !Number.isInteger(snapshot.revision)) {
      const error = new Error('Server returned an invalid complete session snapshot')
      error.code = 'INVALID_SESSION_SNAPSHOT'
      throw error
    }
    const watermark = getServerSessionSnapshotWatermark({
      serverRevision: snapshot.revision,
      serverTurnEventRevision: snapshot.turnEventRevision,
    })
    if (snapshot.messages.length === 0) hydratedRevisions.set(sessionId, watermark)
    else hydratedRevisions.delete(sessionId)
    applyServerAction({
      type: 'APPLY_SERVER_SESSION_SNAPSHOT',
      payload: { sessionId, snapshot },
    })
    return snapshot
  }

  const hydrateSessionSnapshot = (session, action) => {
    if (typeof fetchSessionSnapshot !== 'function' || !canFetchSessionSnapshot()) return undefined
    const sessionId = session?.id
    const watermark = getServerSessionSnapshotWatermark(session)
    if (!needsServerSessionSnapshot(session, hydratedRevisions.get(sessionId))) return undefined

    const pending = snapshotRequests.get(sessionId)
    if (pending && (pending.watermark === watermark || pending.watermark === null || watermark === null)) {
      return pending.promise
    }

    const operation = Promise.resolve()
      .then(async () => {
        if (!isServerBackedSession(session)) {
          if (typeof resolveSessionMetadata !== 'function') return false
          const metadata = await resolveSessionMetadata({ sessionId })
          if (!metadata) return false
          if (!Number.isInteger(metadata.revision)) {
            const error = new Error('Session metadata is missing a valid revision')
            error.code = 'INVALID_SESSION_REVISION'
            throw error
          }
          applyServerAction({
            type: 'APPLY_SERVER_SESSION_METADATA',
            payload: { sessionId, session: metadata },
          })
        }
        const snapshot = await fetchSessionSnapshot({ sessionId })
        applyCompleteSessionSnapshot(sessionId, snapshot)
        return true
      })
      .catch((error) => {
        onError(error, { action, sessionId })
        return false
      })

    const tracked = operation.finally(() => {
      if (snapshotRequests.get(sessionId)?.promise === tracked) snapshotRequests.delete(sessionId)
    })
    snapshotRequests.set(sessionId, { watermark, promise: tracked })
    return tracked
  }

  return function dispatchWithSessionSync(action) {
    if (action?.type === 'SWITCH_SESSION' || action?.type === 'HYDRATE_SERVER_SESSION') {
      const sessionId = typeof action.payload === 'string' ? action.payload : action.payload?.sessionId
      const storedSession = getState()?.sessions?.find((candidate) => candidate.id === sessionId)
      const session = action.type === 'HYDRATE_SERVER_SESSION' && Number.isInteger(action.payload?.revision)
        ? {
            ...(storedSession || {}),
            id: sessionId,
            serverRevision: action.payload.revision,
            ...(Number.isInteger(action.payload?.turnEventRevision)
              ? { serverTurnEventRevision: action.payload.turnEventRevision }
              : {}),
            messages: [],
          }
        : storedSession
      if (action.type === 'SWITCH_SESSION') dispatchImmediate(action)
      return session ? hydrateSessionSnapshot(session, action) : undefined
    }

    if (!isServerSessionMutation(action)) {
      dispatchImmediate(action)
      return undefined
    }

    const initialState = getState()
    const sessionId = resolveSessionMutationTarget(initialState, action)
    const initialSession = initialState?.sessions?.find((candidate) => candidate.id === sessionId)
    if (!sessionId || !initialSession) {
      dispatchImmediate(action)
      return undefined
    }
    if (!isServerBackedSession(initialSession) && typeof resolveSessionMetadata !== 'function') {
      dispatchImmediate(action)
      return undefined
    }

    const previous = queues.get(sessionId) || Promise.resolve()
    const operation = previous.catch(() => false).then(async () => {
      try {
        const currentSession = getState()?.sessions?.find((candidate) => candidate.id === sessionId)
        if (currentSession && !isServerBackedSession(currentSession)) {
          const metadata = await resolveSessionMetadata({ sessionId })
          if (!metadata) {
            dispatchImmediate(action)
            return true
          }
          if (!Number.isInteger(metadata.revision)) {
            const error = new Error('Session metadata is missing a valid revision')
            error.code = 'INVALID_SESSION_REVISION'
            throw error
          }
          applyServerAction({
            type: 'APPLY_SERVER_SESSION_METADATA',
            payload: { sessionId, session: metadata },
          })
        }
        const plan = projectSessionMutation({
          state: getState(),
          action,
          sessionId,
          reduceState,
        })
        if (!plan) return false

        if (plan.kind === 'delete') {
          await deleteSession({
            sessionId: plan.sessionId,
            expectedRevision: plan.expectedRevision,
          })
          applyServerAction({
            type: 'APPLY_SERVER_SESSION_DELETE',
            payload: { sessionId: plan.sessionId },
          })
          return true
        }

        let committedMessages = plan.messages
        let result
        try {
          result = await replaceMessages({
            sessionId: plan.sessionId,
            expectedRevision: plan.expectedRevision,
            messages: plan.messages,
          })
        } catch (error) {
          const canConfirmCommit = canConfirmReplacementAfterError(error)
            && typeof fetchSessionSnapshot === 'function'
            && canFetchSessionSnapshot()
          if (!canConfirmCommit) throw error

          const snapshot = await fetchSessionSnapshot({ sessionId })
          applyCompleteSessionSnapshot(sessionId, snapshot)
          if (sameSessionTranscript(snapshot.messages, plan.messages)) return true

          // Replaying a destructive action against a genuinely newer transcript
          // can erase messages written by another tab. Retry only when the full
          // snapshot proves that the source transcript itself is unchanged, and
          // derive the retry payload from that canonical snapshot rather than
          // from the stale local projection.
          const sourceIsStillCurrent = snapshot.revision >= plan.expectedRevision
            && sameSessionTranscript(snapshot.messages, plan.sourceMessages)
          if (!sourceIsStillCurrent) throw error

          const currentState = getState()
          const retryState = {
            ...currentState,
            sessions: (currentState?.sessions || []).map((session) => (
              session.id === sessionId
                ? { ...session, messages: snapshot.messages, serverRevision: snapshot.revision }
                : session
            )),
          }
          const retryPlan = projectSessionMutation({
            state: retryState,
            action,
            sessionId,
            reduceState,
          })
          if (!retryPlan || retryPlan.kind !== 'replace') throw error

          committedMessages = retryPlan.messages
          result = await replaceMessages({
            sessionId: retryPlan.sessionId,
            expectedRevision: retryPlan.expectedRevision,
            messages: retryPlan.messages,
          })
        }
        applyServerAction({
          type: 'APPLY_SERVER_SESSION_MESSAGES',
          payload: {
            sessionId: plan.sessionId,
            messages: committedMessages,
            revision: result.revision,
          },
        })
        return true
      } catch (error) {
        onError(error, { action, sessionId })
        return false
      }
    })

    const tracked = operation.finally(() => {
      if (queues.get(sessionId) === tracked) queues.delete(sessionId)
    })
    queues.set(sessionId, tracked)
    return operation
  }
}
