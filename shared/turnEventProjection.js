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

function stablePublicFailureRecord(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  if (seen.has(value)) return {}
  seen.add(value)
  const failure = { ...value }
  for (const field of ['message', 'hint', 'reason']) delete failure[field]
  for (const field of ['error', 'cause']) {
    if (!Object.hasOwn(failure, field)) continue
    if (failure[field] && typeof failure[field] === 'object' && !Array.isArray(failure[field])) {
      failure[field] = stablePublicFailureRecord(failure[field], seen)
    } else {
      delete failure[field]
    }
  }
  if (failure.recovery && typeof failure.recovery === 'object' && !Array.isArray(failure.recovery)) {
    const recovery = { ...failure.recovery }
    for (const field of ['message', 'hint', 'reason', 'errorMessage']) delete recovery[field]
    for (const field of ['error', 'cause']) {
      if (!Object.hasOwn(recovery, field)) continue
      if (recovery[field] && typeof recovery[field] === 'object' && !Array.isArray(recovery[field])) {
        recovery[field] = stablePublicFailureRecord(recovery[field], seen)
      } else {
        delete recovery[field]
      }
    }
    failure.recovery = recovery
  }
  return failure
}

function completedEvidenceFields(payload) {
  const fields = {}
  for (const key of [
    'artifactIds',
    'deliveryArtifactIds',
    'verifiedLocalFiles',
    'retainedLocalFiles',
    'iterations',
    'usage',
    'turnModelUsage',
    'estimatedPromptTokens',
  ]) {
    if (Object.hasOwn(payload, key)) fields[key] = payload[key]
  }
  return fields
}

function explicitBoolean(...values) {
  return values.find((value) => typeof value === 'boolean')
}

function failedTaskVerification(payload, error) {
  const verification = completionRecord(payload.taskVerification || error.taskVerification)
  const failed = verification.ok === false
    || verification.passed === false
    || (Array.isArray(verification.checks) && verification.checks.some((check) => (
      FAILED_VERIFICATION_STATUSES.has(String(check?.status || '').trim().toLowerCase())
    )))
  return failed ? verification : null
}

function normalizedIncompleteReason(payload, error, fallback) {
  const value = String(payload.incompleteReason || error.incompleteReason || '').trim().toLowerCase()
  return /^[a-z][a-z0-9_]{0,95}$/u.test(value) ? value : fallback
}

function normalizedMissingRequirements(payload, error, fallback) {
  const values = payload.missingRequirements ?? error.missingRequirements
  const normalized = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => /^[a-z][a-z0-9_]{0,95}$/u.test(value)))]
    .slice(0, 16)
  return normalized.length > 0 ? normalized : fallback
}

function normalizedNextAction(payload, error, fallback) {
  const value = String(payload.nextAction || error.nextAction || '').trim().toLowerCase().slice(0, 80)
  return /^[a-z][a-z0-9_]{0,79}$/u.test(value) ? value : fallback
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
    || payload.blocked === true
    || payload.cancelled === true
    || payload.paused === true
    || payload.interrupted === true
    || error.complete === false
    || error.completed === false
    || error.incomplete === true
    || error.blocked === true
    || error.cancelled === true
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
  return true
}

function projectInvalidCompletedEvent(event) {
  const payload = completionRecord(event.payload)
  const error = completionRecord(payload.error)
  const evidence = completedEvidenceFields(payload)
  const status = String(payload.status || error.status || '').trim().toLowerCase()
  if (payload.interrupted === true || error.interrupted === true || status === 'interrupted') {
    const incompleteReason = normalizedIncompleteReason(
      payload,
      error,
      'model_call_interrupted',
    )
    return {
      ...event,
      type: 'turn.interrupted',
      payload: {
        code: normalizePublicFailureCode(payload.code || error.code, 'TURN_INTERRUPTED'),
        retryable: explicitBoolean(payload.retryable, error.retryable) ?? true,
        text: String(payload.text || ''),
        partialText: String(payload.partialText || payload.text || ''),
        incompleteReason,
        missingRequirements: normalizedMissingRequirements(
          payload,
          error,
          incompleteReason === 'model_call_interrupted'
            ? ['model_response', 'remaining_task_steps']
            : ['remaining_task_steps'],
        ),
        nextAction: normalizedNextAction(payload, error, 'resume_turn'),
        ...(failedTaskVerification(payload, error)
          ? { taskVerification: failedTaskVerification(payload, error) }
          : {}),
        ...evidence,
      },
    }
  }
  if (payload.paused === true || error.paused === true || status === 'paused') {
    const clarification = typeof payload.clarification === 'string' && payload.clarification.trim()
      ? payload.clarification.trim()
      : completionRecord(payload.clarification)
    const incompleteReason = normalizedIncompleteReason(payload, error, 'turn_incomplete')
    return {
      ...event,
      type: 'turn.paused',
      payload: {
        text: String(payload.text || ''),
        clarification: Object.keys(clarification).length > 0
          ? clarification
          : { reason_code: 'clarification_required', blocker_kind: 'missing_info' },
        incompleteReason,
        missingRequirements: normalizedMissingRequirements(
          payload,
          error,
          ['user_clarification'],
        ),
        nextAction: normalizedNextAction(payload, error, 'provide_input'),
        ...evidence,
      },
    }
  }
  const failedVerification = failedTaskVerification(payload, error)
  const incompleteReason = normalizedIncompleteReason(
    payload,
    error,
    failedVerification
      ? 'task_verification_repair_pending'
      : (Array.isArray(payload.retainedLocalFiles) && payload.retainedLocalFiles.length > 0
          ? 'post_mutation_verification_missing'
          : 'turn_incomplete'),
  )
  const code = normalizePublicFailureCode(payload.code || error.code, 'TURN_INCOMPLETE')
  const retryable = explicitBoolean(payload.retryable, error.retryable)
    ?? incompleteReason !== 'task_verification_repair_exhausted'
  const missingRequirements = normalizedMissingRequirements(
    payload,
    error,
    incompleteReason === 'post_mutation_verification_missing'
      ? ['mutation_readback', 'diff_or_project_check']
      : incompleteReason.startsWith('task_verification_')
        ? ['verification_failure_repair', 'passing_project_check']
        : ['remaining_task_steps'],
  )
  const nextAction = normalizedNextAction(payload, error, 'retry_turn')
  return {
    ...event,
    type: 'turn.failed',
    payload: {
      code,
      incompleteReason,
      missingRequirements,
      nextAction,
      ...(failedVerification ? { taskVerification: failedVerification } : {}),
      error: {
        code,
        retryable,
        incompleteReason,
        missingRequirements,
        nextAction,
        ...(failedVerification ? { taskVerification: failedVerification } : {}),
      },
      partialText: String(payload.partialText || payload.text || ''),
      ...evidence,
    },
  }
}

function projectTerminalFailureEvent(event) {
  const fallback = PUBLIC_FAILURE_CODE_FALLBACKS[event.type]
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload
    : {}
  const nestedError = payload.error && typeof payload.error === 'object'
    ? payload.error
    : null
  const projectedCode = normalizePublicFailureCode(payload.code ?? nestedError?.code, fallback)
  const projectedPayload = stablePublicFailureRecord({
    ...payload,
    code: projectedCode,
    ...(nestedError ? {
      error: {
        ...nestedError,
        code: normalizePublicFailureCode(nestedError.code, projectedCode),
      },
    } : {}),
  })
  return { ...event, payload: projectedPayload }
}

function projectPausedEvent(event) {
  const payload = completionRecord(event.payload)
  return { ...event, payload: stablePublicFailureRecord(payload) }
}

/**
 * Remove private state and server-authored failure copy before a Turn event
 * crosses any transport or observer boundary. SSE, WebSocket, headless clients,
 * and runtime plugins must all consume this same projection.
 */
export function projectTurnEventForClient(event) {
  if (event?.type === 'turn.completed' && !isSuccessfulTurnCompletedEvent(event)) {
    return projectInvalidCompletedEvent(event)
  }
  if (Object.hasOwn(PUBLIC_FAILURE_CODE_FALLBACKS, event?.type)) {
    return projectTerminalFailureEvent(event)
  }
  if (event?.type === 'turn.paused') return projectPausedEvent(event)
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
