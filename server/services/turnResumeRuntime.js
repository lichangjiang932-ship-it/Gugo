import { isTerminalTurnEventType } from './turnEventEmitter.js'
import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'
import { recoveryCandidateVersion } from './turnEnginePolicy.js'
import {
  excludeVerifiedLocalFiles,
  isValidActiveFailedRetryAttempt,
  mergeLocalFileReceipts,
  normalizeResolutionPath,
  replayPersistedTurnEvents,
} from './turnRecoveryProjection.js'
import { normalizeServerToolsConfig } from './turnToolSpecs.js'
import { normalizeTurnIntentMode } from '../utils/executionIntent.js'
import {
  normalizeTurnApprovalMode as normalizeTurnApprovalModeOverride,
  normalizeTurnIds as normalizeIds,
  normalizeTurnModelMode as normalizeModelMode,
  normalizeTurnOptionalId as normalizeOptionalId,
} from './turnStartRuntime.js'
import { createTurnResolutionRuntime, TurnEngineError } from './turnResolutionRuntime.js'
import { createTurnResumeDirectoryGrantGuard } from './turnResumeDirectoryGrant.js'
function rejectResumeApprovalModeOverride(value) {
  if (value === null || value === undefined) return
  throw new TurnEngineError(
    'TURN_APPROVAL_MODE_OVERRIDE_FORBIDDEN',
    'approvalMode cannot be changed while resuming a turn; the persisted turn mode is restored',
    409,
  )
}

function activeKey(userId, sessionId, turnId) {
  return `${userId}\u0000${sessionId}\u0000${turnId}`
}

function isTerminalResumeEvent(event) {
  if (!isTerminalTurnEventType(event?.type)) return false
  return event.type !== 'turn.completed' || isSuccessfulTurnCompletedEvent(event)
}

function normalizePositiveInteger(value) {
  const normalized = Number(value)
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null
}

export const DEFAULT_MODEL_INTERRUPTION_MAX_ATTEMPTS = 12

export function resolveModelInterruptionMaxAttempts(env = process.env) {
  const parsed = Math.floor(Number(env?.TURN_MODEL_INTERRUPTION_MAX_ATTEMPTS))
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MODEL_INTERRUPTION_MAX_ATTEMPTS
}

export function modelInterruptionRecoveryState(events = [], maxAttempts = DEFAULT_MODEL_INTERRUPTION_MAX_ATTEMPTS) {
  const limit = Math.max(1, Math.floor(Number(maxAttempts)) || DEFAULT_MODEL_INTERRUPTION_MAX_ATTEMPTS)
  let attempts = 0
  let latest = null
  for (const event of [...events]
    .filter((item) => Number.isInteger(item?.sequence))
    .sort((left, right) => left.sequence - right.sequence)) {
    if (event.type === 'turn.blocked'
      && String(event.payload?.code || '').trim().toUpperCase() === 'TURN_MODEL_RECOVERY_EXHAUSTED') {
      // A durable dead-letter boundary closes the previous automatic retry
      // budget. An explicit retry starts a fresh recovery window instead of
      // immediately inheriting the already exhausted counter.
      attempts = 0
      latest = null
      continue
    }
    if (event.type === 'turn.interrupted') {
      attempts += 1
      latest = event
      continue
    }
    const madeProgress = (event.type === 'assistant.delta' && String(event.payload?.text || '').length > 0)
      || event.type === 'tool.completed'
    if (madeProgress && latest && event.sequence > latest.sequence) {
      attempts = 0
      latest = null
    }
  }
  return {
    attempts,
    limit,
    exhausted: attempts >= limit,
    causeCode: String(latest?.payload?.code || 'MODEL_CALL_INTERRUPTED').trim().toUpperCase(),
  }
}

function persistedPayloadValues(events, field) {
  const values = []
  const fields = Array.isArray(field) ? field : [field]
  for (const event of events) {
    const payload = event?.payload
    for (const fieldName of fields) {
      if (payload && typeof payload === 'object' && Object.hasOwn(payload, fieldName)) {
        values.push(payload[fieldName])
      }
      if (payload?.error && typeof payload.error === 'object'
        && Object.hasOwn(payload.error, fieldName)) {
        values.push(payload.error[fieldName])
      }
    }
  }
  return values
}

function recoveryStateMatchesBoundary(recoveryState, boundary) {
  return Boolean(
    recoveryState?.candidateVersion
    && boundary?.sequence != null
    && recoveryState.candidateVersion === recoveryCandidateVersion(boundary),
  )
}

function isModelRecoveryExhaustedBlock(event) {
  return event?.type === 'turn.blocked'
    && String(event.payload?.code || event.payload?.error?.code || '').trim().toUpperCase()
      === 'TURN_MODEL_RECOVERY_EXHAUSTED'
}

function persistedRecoveryEvidence(events) {
  const evidence = {}
  const partialTextValues = persistedPayloadValues(events, ['partialText', 'text'])
  const partialText = partialTextValues
    .map((value) => String(value || ''))
    .filter((value) => value.trim().length > 0)
    .at(-1)
  if (partialText !== undefined) {
    evidence.partialText = partialText
  } else if (partialTextValues.length > 0) {
    evidence.partialText = ''
  }

  for (const field of ['artifactIds', 'deliveryArtifactIds']) {
    const values = persistedPayloadValues(events, field)
    const ids = [...new Set(values
      .filter(Array.isArray)
      .flat()
      .map((value) => String(value || '').trim())
      .filter(Boolean))]
    if (ids.length > 0 || values.some(Array.isArray)) evidence[field] = ids
  }

  const verifiedValues = persistedPayloadValues(events, 'verifiedLocalFiles')
  const retainedValues = persistedPayloadValues(events, 'retainedLocalFiles')
  const verifiedLocalFiles = mergeLocalFileReceipts(...verifiedValues.filter(Array.isArray))
  const retainedLocalFiles = excludeVerifiedLocalFiles(
    mergeLocalFileReceipts(...retainedValues.filter(Array.isArray)),
    verifiedLocalFiles,
  )
  if (verifiedLocalFiles.length > 0 || verifiedValues.some(Array.isArray)) {
    evidence.verifiedLocalFiles = verifiedLocalFiles
  }
  if (retainedLocalFiles.length > 0 || retainedValues.some(Array.isArray)) {
    evidence.retainedLocalFiles = retainedLocalFiles
  }

  const taskVerification = persistedPayloadValues(events, 'taskVerification')
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length > 0)
    .at(-1)
  if (taskVerification) {
    evidence.taskVerification = taskVerification
  }

  const iterations = persistedPayloadValues(events, 'iterations')
    .map(Number)
    .filter(Number.isFinite)
  if (iterations.length > 0) {
    evidence.iterations = Math.max(0, ...iterations)
  }
  return evidence
}

function attachPersistedRecoveryEvidence(error, events) {
  Object.assign(error, persistedRecoveryEvidence(events))
  return error
}

const {
  hasSufficientDirectoryGrant,
  normalizeResolution: normalizeTurnResolution,
  pauseState,
  validateForPause: validateResolutionForPause,
} = createTurnResolutionRuntime({ normalizePath: normalizeResolutionPath })

/**
 * Durable turn resume orchestration, extracted from the TurnEngine
 * compatibility shell (KERNEL_BOUNDARY transition debt).
 *
 * The host supplies its persistence ports, private callbacks, and the live
 * activation map explicitly; this module owns every resume decision so the
 * engine shrinks toward an adapter/context execution shell without
 * duplicating the terminal-fence semantics.
 */
function deadLetterResumeError(last, recoveryState, events = [last]) {
  const error = new TurnEngineError(
    'TURN_RECOVERY_DEAD_LETTER',
    recoveryState?.errorMessage || last?.payload?.message
      || 'automatic turn recovery stopped; repair the execution environment and retry explicitly',
    409,
  )
  const failure = last?.payload?.error || last?.payload || {}
  error.retryable = false
  error.manualRetryable = true
  error.incompleteReason = failure.incompleteReason || 'recovery_blocked'
  error.missingRequirements = Array.isArray(failure.missingRequirements)
    ? failure.missingRequirements
    : ['execution_environment_repair', 'explicit_recovery_retry']
  error.recovery = recoveryState || {
    status: 'dead_letter',
    retryable: false,
    manualRetryable: true,
    errorCode: failure.code || last?.payload?.code || 'TURN_RECOVERY_BLOCKED',
    errorMessage: last?.payload?.message || 'turn recovery is blocked',
    ...(last ? { candidateVersion: recoveryCandidateVersion(last) } : {}),
  }
  throw attachPersistedRecoveryEvidence(error, events)
}

async function loadTurnResumeState(runtime, input) {
  const { deps, claimLegacySession, getTurn, resolveModelBinding } = runtime
  const { userId, sessionId, turnId, authMode, retryRecovery } = input
  rejectResumeApprovalModeOverride(input.requestedApprovalMode)
  if (!await deps.readSession({ userId, sessionId }) && authMode === 'local') {
    await claimLegacySession({ userId, sessionId, authMode })
  }
  const key = activeKey(userId, sessionId, turnId)
  const scope = { userId, sessionId, turnId }
  const started = await deps.lastEvent({ ...scope, type: 'turn.started' })
  if (!started) throw new TurnEngineError('TURN_NOT_FOUND', 'turn not found', 404)
  let last = await deps.lastEvent(scope)
  if (isTerminalResumeEvent(last)) {
    return { terminal: true, result: {
      turn: await getTurn(scope), scheduled: false, locallyActive: false, terminal: true,
    } }
  }
  const recoveryState = await deps.readRecoveryState(scope)
  const currentRecoveryState = recoveryStateMatchesBoundary(recoveryState, last)
    ? recoveryState
    : null
  if ((last?.type === 'turn.blocked' || currentRecoveryState?.status === 'dead_letter')
    && retryRecovery !== true) {
    deadLetterResumeError(last, currentRecoveryState)
  }
  const modelBinding = resolveModelBinding({
    userId,
    modelName: started.payload.modelName,
    modelProviderId: normalizeOptionalId(started.payload.modelProviderId),
    modelConfigRevision: normalizePositiveInteger(started.payload.modelConfigRevision),
    modelMode: normalizeModelMode(started.payload.modelMode),
    requirePersistedBinding: true,
  })
  let persistedEvents = await replayPersistedTurnEvents(deps.replayEvents, scope)
  const replayBoundary = persistedEvents.at(-1)
  if (Number.isInteger(replayBoundary?.sequence)
    && replayBoundary.sequence > (Number(last?.sequence) || 0)) last = replayBoundary
  if (isTerminalResumeEvent(last)) {
    return { terminal: true, result: {
      turn: await getTurn(scope), scheduled: false, locallyActive: false, terminal: true,
    } }
  }
  if (last?.type === 'turn.blocked' && retryRecovery !== true) {
    deadLetterResumeError(last, null, persistedEvents)
  }
  return { terminal: false, key, scope, started, last, modelBinding, persistedEvents }
}

async function blockExhaustedModelRecovery(runtime, input, resumeState) {
  const { deps, createEmitter, getTurn } = runtime
  let { last, persistedEvents } = resumeState
  let recovery = modelInterruptionRecoveryState(
    persistedEvents,
    resolveModelInterruptionMaxAttempts(deps.env),
  )
  if (recovery.exhausted) {
    const latestBoundary = await deps.lastEvent(resumeState.scope)
    if (isTerminalResumeEvent(latestBoundary)) {
      return { terminal: true, result: {
        turn: await getTurn(resumeState.scope),
        scheduled: false,
        locallyActive: false,
        terminal: true,
      } }
    }
    if (isModelRecoveryExhaustedBlock(latestBoundary)) {
      const failure = latestBoundary.payload?.error || latestBoundary.payload || {}
      const error = new TurnEngineError(
        'TURN_MODEL_RECOVERY_EXHAUSTED',
        `model recovery stopped after ${Number(failure.attempts) || recovery.attempts} interruptions without durable progress`,
        409,
      )
      error.retryable = false
      error.manualRetryable = true
      error.incompleteReason = failure.incompleteReason || 'recovery_attempts_exhausted'
      error.missingRequirements = Array.isArray(failure.missingRequirements)
        ? failure.missingRequirements
        : ['model_service_available', 'explicit_recovery_retry']
      error.attempts = Number(failure.attempts) || recovery.attempts
      error.causeCode = String(failure.causeCode || recovery.causeCode).trim().toUpperCase()
      throw attachPersistedRecoveryEvidence(error, [...persistedEvents, latestBoundary])
    }
    if (latestBoundary?.sequence !== last?.sequence) {
      last = latestBoundary || last
      persistedEvents = await replayPersistedTurnEvents(deps.replayEvents, resumeState.scope)
      recovery = modelInterruptionRecoveryState(
        persistedEvents,
        resolveModelInterruptionMaxAttempts(deps.env),
      )
    }
  }
  if (!recovery.exhausted) return { ...resumeState, last, persistedEvents }
  const error = new TurnEngineError(
    'TURN_MODEL_RECOVERY_EXHAUSTED',
    `model recovery stopped after ${recovery.attempts} interruptions without durable progress`,
    409,
  )
  error.retryable = false
  error.manualRetryable = true
  error.incompleteReason = 'recovery_attempts_exhausted'
  error.missingRequirements = ['model_service_available', 'explicit_recovery_retry']
  error.attempts = recovery.attempts
  error.causeCode = recovery.causeCode
  attachPersistedRecoveryEvidence(error, persistedEvents)
  const failure = {
    code: error.code,
    status: error.status,
    retryable: false,
    manualRetryable: true,
    incompleteReason: error.incompleteReason,
    missingRequirements: error.missingRequirements,
    attempts: error.attempts,
    causeCode: error.causeCode,
  }
  const emitter = createEmitter({ ...resumeState.scope, sequence: last.sequence + 1 })
  let blockedEvent
  let wroteBlockedEvent = false
  try {
    blockedEvent = await emitter('turn.blocked', {
      code: error.code,
      error: failure,
      incompleteReason: error.incompleteReason,
      missingRequirements: error.missingRequirements,
      ...persistedRecoveryEvidence(persistedEvents),
      retryable: false,
      manualRetryable: true,
      recoveryStatus: 'dead_letter',
      attempts: error.attempts,
      causeCode: error.causeCode,
    })
    wroteBlockedEvent = true
  } catch (writeError) {
    const concurrentBoundary = await deps.lastEvent(resumeState.scope)
    if (!isModelRecoveryExhaustedBlock(concurrentBoundary)) throw writeError
    blockedEvent = concurrentBoundary
    const persistedFailure = concurrentBoundary.payload?.error || concurrentBoundary.payload || {}
    error.incompleteReason = persistedFailure.incompleteReason || error.incompleteReason
    error.missingRequirements = Array.isArray(persistedFailure.missingRequirements)
      ? persistedFailure.missingRequirements
      : error.missingRequirements
    error.attempts = Number(persistedFailure.attempts) || error.attempts
    error.causeCode = String(persistedFailure.causeCode || error.causeCode).trim().toUpperCase()
    attachPersistedRecoveryEvidence(error, [...persistedEvents, concurrentBoundary])
  } finally {
    await emitter.close()
  }
  if (wroteBlockedEvent) {
    const candidateVersion = recoveryCandidateVersion(blockedEvent)
    const latestBoundary = await deps.lastEvent(resumeState.scope)
    if (latestBoundary && recoveryCandidateVersion(latestBoundary) === candidateVersion) {
      try {
        await deps.writeRecoveryFailure({
          ...resumeState.scope,
          candidateVersion,
          retryable: false,
          errorCode: error.code,
          errorMessage: error.message,
          now: blockedEvent.createdAt,
        })
      } catch (recoveryStateError) {
        error.cause = recoveryStateError
      }
    }
  }
  throw error
}

function failedRetryState(deps, scope, persistedEvents) {
  const latestFailedRetry = persistedEvents
    .filter((event) => event.type === 'turn.attempt' && event.payload?.reason === 'failed_retry')
    .at(-1)
  const pending = Boolean(latestFailedRetry) && !persistedEvents.some((event) => (
    event.sequence > latestFailedRetry.sequence && isTerminalResumeEvent(event)
  ))
  return { latestFailedRetry, pending }
}

async function scheduleTurnResume(runtime, input, resumeState) {
  const { deps, active, createEmitter, schedule, getTurn, assertCurrentDirectoryGrant } = runtime
  const { userId, resolution } = input
  const { scope, key, started, modelBinding, persistedEvents } = resumeState
  let last = resumeState.last
  const retry = failedRetryState(deps, scope, persistedEvents)
  let failedRetryActive = false
  if (retry.pending) {
    const checkpoint = await deps.runtimeCore.checkpoint.load(scope)
    failedRetryActive = isValidActiveFailedRetryAttempt(persistedEvents, retry.latestFailedRetry, checkpoint)
    if (!failedRetryActive) {
      const error = new TurnEngineError(
        'TURN_FAILED_RETRY_ATTEMPT_INVALID',
        'the persisted failed Turn retry is not bound to its failure and checkpoint',
        409,
      )
      error.retryable = false
      throw attachPersistedRecoveryEvidence(error, persistedEvents)
    }
  }
  const manualFailedRetryActive = failedRetryActive && retry.latestFailedRetry.payload?.manualRetry === true
  const pause = pauseState(persistedEvents)
  const normalizedResolution = resolution == null ? null : normalizeTurnResolution(resolution)
  let resumeContext = pause.resumed
    ? { resolution: pause.resumed.payload.resolution, pausedSequence: pause.resumed.payload.pausedSequence }
    : null
  const running = active.get(key)
  let directoryGrantVerified = false
  if (pause.pending) {
    if (!normalizedResolution) {
      return {
        turn: { ...await getTurn(scope), status: 'paused' },
        scheduled: false, locallyActive: false, terminal: false, paused: true,
      }
    }
    validateResolutionForPause(normalizedResolution, pause.paused)
    if (normalizedResolution.type === 'directory_authorization') {
      assertCurrentDirectoryGrant(userId, normalizedResolution)
      directoryGrantVerified = true
    }
    const emitter = createEmitter({ ...scope, sequence: last.sequence + 1 })
    let resumedEvent
    try {
      resumedEvent = await emitter('turn.resumed', {
        resolution: normalizedResolution,
        pausedSequence: pause.paused.sequence,
      })
    } finally { await emitter.close() }
    resumeContext = { resolution: normalizedResolution, pausedSequence: pause.paused.sequence }
    last = resumedEvent
    if (running?.promise) await running.promise
    last = await deps.lastEvent(scope) || last
    if (isTerminalResumeEvent(last)) {
      return { turn: await getTurn(scope), scheduled: false, locallyActive: false, terminal: true }
    }
  } else if (running) {
    return { turn: await getTurn(scope), scheduled: false, locallyActive: true, terminal: false }
  }
  if (!directoryGrantVerified && resumeContext?.resolution?.type === 'directory_authorization') {
    assertCurrentDirectoryGrant(userId, resumeContext.resolution)
  }
  const emitter = createEmitter({ ...scope, sequence: last.sequence + 1 })
  const workspacePath = String(started.payload.workspacePath || '').trim() || null
  const projectDirectory = String(started.payload.projectDirectory || '').trim() || null
  const recoveredDirectory = workspacePath
    ? await deps.resolveProjectDirectory({ userId, workspacePath })
    : {
        workspacePath: null,
        projectDirectory,
        defaultOutputDirectory: projectDirectory,
      }
  const scheduled = await schedule({
    ...scope,
    turnStartedAt: started.createdAt,
    content: String(started.payload.content || ''),
    displayContent: String(started.payload.displayContent || started.payload.content || ''),
    ...(started.payload.locale ? { locale: started.payload.locale } : {}),
    modelName: modelBinding.modelName,
    modelProviderId: modelBinding.modelProviderId,
    modelConfigRevision: modelBinding.modelConfigRevision,
    modelRuntimeEnv: modelBinding.env,
    modelMode: normalizeModelMode(started.payload.modelMode),
    agentId: normalizeOptionalId(started.payload.agentId),
    skillIds: normalizeIds(started.payload.skillIds),
    skillDefinitions: deps.prepareInlineSkills({
      skillIds: normalizeIds(started.payload.skillIds),
      skillDefinitions: started.payload.skillDefinitions,
    }),
    toolsConfig: normalizeServerToolsConfig(started.payload.toolsConfig),
    intentMode: normalizeTurnIntentMode(started.payload.intentMode),
    approvalMode: normalizeTurnApprovalModeOverride(started.payload.approvalMode),
    projectDirectory: recoveredDirectory?.projectDirectory || null,
    defaultOutputDirectory: recoveredDirectory?.defaultOutputDirectory
      || recoveredDirectory?.projectDirectory || null,
    failedRetryActive,
    manualFailedRetryActive,
    resumeContext,
    emitter,
  })
  if (!scheduled) await emitter.close()
  return {
    turn: await getTurn(scope),
    scheduled,
    locallyActive: scheduled || active.has(key),
    terminal: false,
  }
}

async function resumeTurn(runtime, input) {
  const loaded = await loadTurnResumeState(runtime, input)
  if (loaded.terminal) return loaded.result
  const recovered = await blockExhaustedModelRecovery(runtime, input, loaded)
  if (recovered.terminal) return recovered.result
  return scheduleTurnResume(runtime, input, recovered)
}

export function createTurnResumeRuntime({
  deps,
  claimLegacySession,
  getTurn,
  resolveModelBinding,
  active,
  createEmitter,
  schedule,
}) {
  const runtime = {
    deps,
    claimLegacySession,
    getTurn,
    resolveModelBinding,
    active,
    createEmitter,
    schedule,
    assertCurrentDirectoryGrant: createTurnResumeDirectoryGrantGuard({
      readFileAccessStatus: (input) => deps.readFileAccessStatus(input),
      hasSufficientDirectoryGrant,
    }),
  }
  return {
    resumeTurn: (input = {}) => resumeTurn(runtime, {
      resolution: null,
      authMode: null,
      retryRecovery: false,
      ...input,
      requestedApprovalMode: input.approvalMode ?? null,
    }),
  }
}
