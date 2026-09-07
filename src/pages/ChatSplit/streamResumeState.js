const RESUMABLE_TRUNCATION_CODES = new Set([
  'STREAM_TRUNCATED',
  'EMPTY_MODEL_RESPONSE_LENGTH',
  'TURN_INCOMPLETE',
])

function resultError(result) {
  if (result instanceof Error) return result
  return result?.failed === true ? result.error : null
}

function nonEmptyString(value) {
  const normalized = String(value || '').trim()
  return normalized || null
}

export function buildStreamResumeState(result, { sessionId = null, turnId = null } = {}) {
  const error = resultError(result)
  if (!error || error.name === 'AbortError' || error.code === 'USER_STOPPED') return null

  const code = String(error.code || '').trim()
  const partialText = String(error.partialText || '')
  const manualRetryable = error.manualRetryable === true
  const normalizedSessionId = nonEmptyString(sessionId)
  const normalizedTurnId = nonEmptyString(turnId || error.turnId || result?.turnId)
  const explicitlyResumable = manualRetryable || (error.retryable !== false
    && (code !== 'TURN_INCOMPLETE' || error.retryable === true)
  )
  if (
    !normalizedSessionId
    || !normalizedTurnId
    || (!partialText.trim() && !manualRetryable)
    || (!RESUMABLE_TRUNCATION_CODES.has(code) && !manualRetryable)
    || !explicitlyResumable
  ) return null

  return {
    sessionId: normalizedSessionId,
    turnId: normalizedTurnId,
    code,
    ...(manualRetryable ? { manualRetryable: true } : {}),
    reason: String(error.reason || '').trim() || null,
    partialText,
  }
}

export function latestStreamResumeMessage(messages) {
  const history = Array.isArray(messages) ? messages : []
  let steeringTurnId = null
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]
    if (message?.role === 'assistant') {
      return !steeringTurnId || message.meta?.serverTurnId === steeringTurnId ? message : null
    }
    if (message?.role !== 'user') continue
    const turnId = nonEmptyString(message.meta?.serverTurnId)
    // Steering belongs to the existing turn; an ordinary user message starts a
    // new conversation boundary even before its assistant placeholder exists.
    if (message.meta?.steering !== true || !turnId || steeringTurnId && steeringTurnId !== turnId) return null
    steeringTurnId = turnId
  }
  return null
}

export function streamResumeDismissalKey(message, { sessionId = null } = {}) {
  const meta = message?.meta
  const normalizedSessionId = nonEmptyString(sessionId)
  const turnId = nonEmptyString(meta?.serverTurnId)
  if (!normalizedSessionId || !turnId || meta?.failed !== true) return null
  const boundary = Number.isInteger(meta.serverLastSequence) && meta.serverLastSequence >= 0
    ? ['sequence', meta.serverLastSequence]
    : ['completedAt', meta.turnCompletedAt ?? null]
  return JSON.stringify([normalizedSessionId, turnId, boundary, meta.serverFailure?.code || ''])
}

export function buildStreamResumeStateFromMessages(
  messages,
  { sessionId = null, dismissedKeys = null } = {},
) {
  const latestServerAssistant = latestStreamResumeMessage(messages)
  const dismissalKey = streamResumeDismissalKey(latestServerAssistant, { sessionId })
  if (!dismissalKey || dismissedKeys?.has(dismissalKey)) return null

  const failure = latestServerAssistant.meta.serverFailure
  if (!failure || typeof failure !== 'object') return null
  return buildStreamResumeState({
    failed: true,
    error: {
      ...failure,
      partialText: String(
        latestServerAssistant.meta.serverPartialText
        || latestServerAssistant.content
        || '',
      ),
    },
  }, {
    sessionId,
    turnId: latestServerAssistant.meta.serverTurnId,
  })
}

export function getStreamResumeStateForSession(resumeStates, sessionId) {
  const normalizedSessionId = nonEmptyString(sessionId)
  if (!normalizedSessionId || !resumeStates || typeof resumeStates !== 'object') return null
  const state = resumeStates[normalizedSessionId]
  return isStreamResumeStateForSession(state, normalizedSessionId) ? state : null
}

export function updateStreamResumeStates(resumeStates, sessionId, resumeState) {
  const normalizedSessionId = nonEmptyString(sessionId)
  const current = resumeStates && typeof resumeStates === 'object' ? resumeStates : {}
  if (!normalizedSessionId) return current

  if (!isStreamResumeStateForSession(resumeState, normalizedSessionId)) {
    if (!Object.hasOwn(current, normalizedSessionId)) return current
    const next = { ...current }
    delete next[normalizedSessionId]
    return next
  }
  if (current[normalizedSessionId] === resumeState) return current
  return { ...current, [normalizedSessionId]: resumeState }
}

export function updateStreamResumeStatesFromTurnResult(
  resumeStates,
  { sessionId = null, turnId = null, result = null } = {},
) {
  return updateStreamResumeStates(
    resumeStates,
    sessionId,
    buildStreamResumeState(result, { sessionId, turnId }),
  )
}

export function isStreamResumeStateForSession(resumeState, sessionId) {
  return Boolean(
    resumeState
    && resumeState.sessionId
    && resumeState.turnId
    && resumeState.sessionId === sessionId,
  )
}
