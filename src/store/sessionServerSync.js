const SERVER_MUTATION_TYPES = new Set([
  'DELETE_SESSION',
  'CLEAR_CURRENT_SESSION',
  'DELETE_MESSAGE',
  'COMPRESS_CURRENT_SESSION',
  'COMPACT_SESSION',
  'EXPAND_COMPACTED',
])

const ACTIVE_SESSION_MUTATION_TYPES = new Set([
  'CLEAR_CURRENT_SESSION',
  'DELETE_MESSAGE',
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

export function needsServerTranscriptHydration(session) {
  if (!isServerBackedSession(session)) return false
  const messages = Array.isArray(session.messages) ? session.messages : []
  return messages.length === 0 || messages.every((message) => (
    message?.meta?.pendingServerSync === true || message?.meta?.streaming === true
  ))
}

export function needsServerSessionSnapshot(session, hydratedRevision) {
  return needsServerTranscriptHydration(session)
    && hydratedRevision !== session.serverRevision
}

function normalizedArtifactIds(artifacts) {
  return [...new Set((Array.isArray(artifacts) ? artifacts : [])
    .map((artifact) => String(artifact?.id || '').trim())
    .filter(Boolean))].sort()
}

function sameArtifactCollection(left, right) {
  const leftIds = normalizedArtifactIds(left)
  const rightIds = normalizedArtifactIds(right)
  return leftIds.length === rightIds.length
    && leftIds.every((id, index) => id === rightIds[index])
}

export function mergeServerSessionMessages(localMessages, serverMessages) {
  const localById = new Map(
    (Array.isArray(localMessages) ? localMessages : [])
      .filter((message) => message?.id)
      .map((message) => [message.id, message]),
  )
  const serverIds = new Set()
  const mergedMessages = (Array.isArray(serverMessages) ? serverMessages : []).map((serverMessage) => {
    if (serverMessage?.id) serverIds.add(serverMessage.id)
    const localMessage = localById.get(serverMessage?.id)
    if (!localMessage) return serverMessage
    const serverMeta = serverMessage?.meta && typeof serverMessage.meta === 'object'
      ? serverMessage.meta
      : {}
    const localMeta = localMessage?.meta && typeof localMessage.meta === 'object'
      ? localMessage.meta
      : {}
    const merged = {
      ...serverMessage,
      ...localMessage,
      id: serverMessage.id,
      role: serverMessage.role,
      // A completed snapshot should be authoritative, but an unexpectedly empty
      // assistant row must not erase text already received over the live stream.
      content: serverMessage.content || localMessage.content || '',
      timestamp: serverMessage.timestamp ?? localMessage.timestamp,
    }
    if (Object.keys(serverMeta).length || Object.keys(localMeta).length) {
      merged.meta = { ...serverMeta, ...localMeta }
      delete merged.meta.pendingServerSync
      if (serverMessage.role === 'assistant') {
        const recoveryStub = serverMeta.serverRecoveryStub === true
        const canonicalTextChanged = !recoveryStub && merged.content !== localMessage.content
        if (canonicalTextChanged) {
          if (Array.isArray(serverMeta.toolCalls)) {
            // Live text offsets are coordinates into the local streamed body.
            // Once an authoritative snapshot replaces that body, only the
            // snapshot's tool calls are safe to use for timeline slicing.
            merged.meta.toolCalls = serverMeta.toolCalls
          } else if (Array.isArray(localMeta.toolCalls)) {
            merged.meta.toolCalls = localMeta.toolCalls.map((call) => {
              if (!call || typeof call !== 'object' || !Object.hasOwn(call, 'textOffset')) return call
              const normalized = { ...call }
              delete normalized.textOffset
              return normalized
            })
          }
        }
        merged.meta.serverTurnId = serverMeta.serverTurnId ?? localMeta.serverTurnId ?? null
        merged.meta.streaming = recoveryStub
        merged.meta.serverAuthoritative = !recoveryStub
        if (recoveryStub) merged.meta.serverRecoveryStub = true
        else delete merged.meta.serverRecoveryStub
        // A completed snapshot is the source of truth for persisted files.
        // Keep local artifacts only when an older server response does not
        // expose the field at all; an explicit server list must replace an
        // empty or partial list left behind by a missed live tool event.
        if (Object.hasOwn(serverMeta, 'serverArtifacts')) {
          merged.meta.serverArtifacts = serverMeta.serverArtifacts
        }
        if (Object.hasOwn(serverMeta, 'serverDeliveryArtifactIds')) {
          merged.meta.serverDeliveryArtifactIds = serverMeta.serverDeliveryArtifactIds
        } else if (!recoveryStub
          && Object.hasOwn(serverMeta, 'serverArtifacts')
          && Object.hasOwn(localMeta, 'serverDeliveryArtifactIds')
          && !sameArtifactCollection(localMeta.serverArtifacts, serverMeta.serverArtifacts)) {
          // A delivery selection is valid only for the artifact collection it
          // was made against. If an authoritative snapshot exposes a different
          // collection but predates the delivery field, retaining the local
          // IDs can revive a draft that the current turn already invalidated.
          merged.meta.serverDeliveryArtifactIds = []
        }

        const serverPauseSequence = Number.isInteger(serverMeta.serverLastSequence)
          ? serverMeta.serverLastSequence
          : null
        const localSequence = Number.isInteger(localMeta.serverLastSequence)
          ? localMeta.serverLastSequence
          : null
        const localResumeInFlight = localMeta.directoryAuthorizationPending === true
          || localMeta.serverResumeResolution != null
        const localHasNewerTurnState = serverPauseSequence !== null
          && localSequence !== null
          && localSequence > serverPauseSequence

        if (serverMeta.paused === true && (localResumeInFlight || localHasNewerTurnState)) {
          // A snapshot may race with the user's authorization or with newer
          // streamed events. Retain that newer local lifecycle state. While an
          // authorization is in flight, the server clarification is still the
          // canonical request shown by the busy inline card.
          merged.meta.streaming = localMeta.streaming === true
          if (localResumeInFlight
            && localMeta.serverClarification == null
            && serverMeta.serverClarification != null) {
            merged.meta.serverClarification = serverMeta.serverClarification
          }
        } else if (serverMeta.paused === true) {
          // Persisted pause state is authoritative over stale live metadata.
          // In particular, a local `serverClarification: null` must not erase
          // the directory request before MessageRow can render its inline card.
          merged.meta.paused = true
          merged.meta.streaming = false
          merged.meta.serverConnectionState = serverMeta.serverConnectionState || 'paused'
          merged.meta.serverClarification = serverMeta.serverClarification ?? null
          merged.meta.directoryAuthorizationPending = false
          merged.meta.serverResumeResolution = null
          if (serverPauseSequence !== null) {
            merged.meta.serverLastSequence = serverPauseSequence
          }
        }
      }
    }
    return merged
  })
  const pendingLocal = (Array.isArray(localMessages) ? localMessages : []).filter((message) => (
    message?.id && !serverIds.has(message.id)
    && (message?.meta?.pendingServerSync === true || message?.meta?.streaming === true)
  ))
  return [...mergedMessages, ...pendingLocal].sort((left, right) => (
    Number(left?.timestamp || 0) - Number(right?.timestamp || 0)
  ))
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

  const hydrateSessionSnapshot = (session, action) => {
    if (typeof fetchSessionSnapshot !== 'function' || !canFetchSessionSnapshot()) return undefined
    const sessionId = session?.id
    const revision = session?.serverRevision
    if (!needsServerSessionSnapshot(session, hydratedRevisions.get(sessionId))) return undefined

    const pending = snapshotRequests.get(sessionId)
    if (pending?.revision === revision) return pending.promise

    const operation = Promise.resolve()
      .then(() => fetchSessionSnapshot({ sessionId }))
      .then((snapshot) => {
        if (snapshot?.complete !== true || !Array.isArray(snapshot.messages) || !Number.isInteger(snapshot.revision)) {
          const error = new Error('Server returned an invalid complete session snapshot')
          error.code = 'INVALID_SESSION_SNAPSHOT'
          throw error
        }
        if (snapshot.messages.length === 0) hydratedRevisions.set(sessionId, snapshot.revision)
        else hydratedRevisions.delete(sessionId)
        applyServerAction({
          type: 'APPLY_SERVER_SESSION_SNAPSHOT',
          payload: { sessionId, snapshot },
        })
        return true
      })
      .catch((error) => {
        onError(error, { action, sessionId })
        return false
      })

    const tracked = operation.finally(() => {
      if (snapshotRequests.get(sessionId)?.promise === tracked) snapshotRequests.delete(sessionId)
    })
    snapshotRequests.set(sessionId, { revision, promise: tracked })
    return tracked
  }

  return function dispatchWithSessionSync(action) {
    if (action?.type === 'SWITCH_SESSION' || action?.type === 'HYDRATE_SERVER_SESSION') {
      const sessionId = typeof action.payload === 'string' ? action.payload : action.payload?.sessionId
      const storedSession = getState()?.sessions?.find((candidate) => candidate.id === sessionId)
      const session = action.type === 'HYDRATE_SERVER_SESSION' && Number.isInteger(action.payload?.revision)
        ? { ...(storedSession || {}), id: sessionId, serverRevision: action.payload.revision, messages: [] }
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

        const result = await replaceMessages({
          sessionId: plan.sessionId,
          expectedRevision: plan.expectedRevision,
          messages: plan.messages,
        })
        applyServerAction({
          type: 'APPLY_SERVER_SESSION_MESSAGES',
          payload: {
            sessionId: plan.sessionId,
            messages: plan.messages,
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
