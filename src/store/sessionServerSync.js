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

export function mergeServerSessionMessages(localMessages, serverMessages) {
  const localById = new Map(
    (Array.isArray(localMessages) ? localMessages : [])
      .filter((message) => message?.id)
      .map((message) => [message.id, message]),
  )
  return (Array.isArray(serverMessages) ? serverMessages : []).map((serverMessage) => {
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
      content: serverMessage.content,
      timestamp: serverMessage.timestamp ?? localMessage.timestamp,
    }
    if (Object.keys(serverMeta).length || Object.keys(localMeta).length) {
      merged.meta = { ...serverMeta, ...localMeta }
      if (serverMessage.role === 'assistant') {
        merged.meta.serverTurnId = serverMeta.serverTurnId ?? localMeta.serverTurnId ?? null
        merged.meta.streaming = false
        merged.meta.serverAuthoritative = true
      }
    }
    return merged
  })
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
  onError = () => {},
}) {
  const queues = new Map()

  return function dispatchWithSessionSync(action) {
    if (!isServerSessionMutation(action)) {
      dispatchImmediate(action)
      return undefined
    }

    const initialState = getState()
    const sessionId = resolveSessionMutationTarget(initialState, action)
    const initialSession = initialState?.sessions?.find((candidate) => candidate.id === sessionId)
    if (!sessionId || !isServerBackedSession(initialSession)) {
      dispatchImmediate(action)
      return undefined
    }

    const previous = queues.get(sessionId) || Promise.resolve()
    const operation = previous.catch(() => false).then(async () => {
      try {
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
