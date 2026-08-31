const PUBLIC_FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u
const INCOMPLETE_COMPLETION_STATUSES = new Set([
  'blocked', 'cancelled', 'failed', 'incomplete', 'interrupted', 'paused',
])
const FAILED_VERIFICATION_STATUSES = new Set([
  'failed', 'indeterminate', 'rerun_required', 'stale',
])
const PUBLIC_FAILURE_CODE_FALLBACKS = Object.freeze({
  'turn.failed': 'TURN_FAILED',
  'turn.interrupted': 'TURN_INTERRUPTED',
  'turn.blocked': 'TURN_RECOVERY_BLOCKED',
  'turn.cancelled': 'TURN_CANCELLED',
})

function normalizedCodeCandidate(value) {
  try {
    const candidate = String(value ?? '').trim().toUpperCase()
    return PUBLIC_FAILURE_CODE_PATTERN.test(candidate) ? candidate : ''
  } catch {
    return ''
  }
}

export function normalizePublicFailureCode(value, fallback = 'TURN_FAILED') {
  return normalizedCodeCandidate(value)
    || normalizedCodeCandidate(fallback)
    || 'TURN_FAILED'
}

function completionRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * Treat a completed event as successful only when its payload contains no
 * contradictory incomplete evidence. This also protects readers of legacy or
 * externally imported logs whose event type predates the completion gate.
 */
export function isSuccessfulTurnCompletedEvent(event) {
  if (event?.type !== 'turn.completed') return false
  const payload = completionRecord(event.payload)
  const error = completionRecord(payload.error)
  if (payload.complete === false
    || payload.completed === false
    || payload.incomplete === true
    || payload.paused === true
    || payload.interrupted === true
    || error.complete === false
    || error.completed === false
    || error.incomplete === true
    || error.paused === true
    || error.interrupted === true) return false
  const status = String(payload.status || error.status || '').trim().toLowerCase()
  if (INCOMPLETE_COMPLETION_STATUSES.has(status)) return false
  if (String(payload.incompleteReason || error.incompleteReason || '').trim()) return false
  const missingRequirements = payload.missingRequirements ?? error.missingRequirements
  if (Array.isArray(missingRequirements) && missingRequirements.length > 0) return false
  const taskVerification = completionRecord(payload.taskVerification || error.taskVerification)
  if (Array.isArray(taskVerification.checks) && taskVerification.checks.some((check) => (
    FAILED_VERIFICATION_STATUSES.has(String(check?.status || '').trim().toLowerCase())
  ))) return false
  if (taskVerification.ok === false || taskVerification.passed === false) return false
  const retained = Array.isArray(payload.retainedLocalFiles) ? payload.retainedLocalFiles : []
  // A retained receipt means the write is known to exist but has not passed
  // readback/project verification. Path equality with an older verified
  // receipt is not enough: the same path may have been mutated again later.
  if (retained.length > 0) return false
  return true
}

function projectTerminalFailureEvent(event) {
  const fallback = PUBLIC_FAILURE_CODE_FALLBACKS[event.type]
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload
    : {}
  const nestedError = payload.error && typeof payload.error === 'object'
    ? payload.error
    : null
  const projectedPayload = {
    ...payload,
    code: normalizePublicFailureCode(payload.code ?? nestedError?.code, fallback),
  }
  delete projectedPayload.message
  delete projectedPayload.hint
  delete projectedPayload.reason
  if (nestedError) {
    const projectedError = {
      ...nestedError,
      code: normalizePublicFailureCode(nestedError.code, projectedPayload.code),
    }
    delete projectedError.message
    delete projectedError.hint
    delete projectedError.reason
    projectedPayload.error = projectedError
  }
  return { ...event, payload: projectedPayload }
}

/**
 * Remove private state and server-authored failure copy before a Turn event
 * crosses any transport or observer boundary. SSE, WebSocket, headless clients,
 * and runtime plugins must all consume this same projection.
 */
export function projectTurnEventForClient(event) {
  if (Object.hasOwn(PUBLIC_FAILURE_CODE_FALLBACKS, event?.type)) {
    return projectTerminalFailureEvent(event)
  }
  if (event?.type !== 'turn.checkpoint') return event
  if (event.payload?.storage === 'turn_checkpoints') return event
  const state = event.payload?.state && typeof event.payload.state === 'object'
    ? event.payload.state
    : {}
  const budget = state.budget && typeof state.budget === 'object' ? state.budget : {}
  return {
    ...event,
    payload: {
      state: {
        iterations: Math.max(0, Number(state.iterations) || 0),
        toolCalls: Array.isArray(state.toolCalls) ? state.toolCalls.length : 0,
        artifactCount: Array.isArray(state.artifactIds) ? state.artifactIds.length : 0,
        budget: {
          used: Math.max(0, Number(budget.used) || 0),
          maxTotalCalls: Math.max(0, Number(budget.maxTotalCalls) || 0),
          modelCalls: Math.max(0, Number(budget.modelCalls) || 0),
          maxModelCalls: Math.max(0, Number(budget.maxModelCalls) || 0),
        },
      },
    },
  }
}
