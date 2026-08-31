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

export function buildStreamResumeStateFromMessages(messages, { sessionId = null } = {}) {
  const latestServerAssistant = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((message) => message?.role === 'assistant' && nonEmptyString(message?.meta?.serverTurnId))
  if (!latestServerAssistant?.meta?.failed) return null

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
