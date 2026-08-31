import { isTerminalTurnEventType } from './turnEventEmitter.js'
import { recoveryCandidateVersion } from './turnEnginePolicy.js'
import {
  isValidActiveFailedRetryAttempt,
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

function latestPersistedPayloadField(events, field, fallback) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload
    if (payload && typeof payload === 'object' && Object.hasOwn(payload, field)) {
      return payload[field]
    }
  }
  return fallback
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
export function createTurnResumeRuntime({
  deps,
  claimLegacySession,
  getTurn,
  resolveModelBinding,
  active,
  createEmitter,
  schedule,
}) {
  function assertCurrentDirectoryGrant(userId, resolution) {
    if (resolution?.type !== 'directory_authorization') return
    let grants
    try {
      grants = deps.readFileAccessStatus({ userId })?.grants || []
    } catch (error) {
      const wrapped = new TurnEngineError(
        'TURN_DIRECTORY_GRANT_CHECK_FAILED',
        'failed to verify the persisted directory authorization',
        500,
      )
      wrapped.cause = error
      throw wrapped
    }
    if (!hasSufficientDirectoryGrant(grants, resolution)) {
      throw new TurnEngineError(
        'TURN_DIRECTORY_GRANT_NOT_FOUND',
        'the requested directory authorization is not persisted for this user',
        403,
      )
    }
  }

  /**
   * Startup recovery needs to distinguish "another process owns the lease"
   * from "this process scheduled the turn". The public resume response stays
   * unchanged; this explicit outcome is only used by durable recovery workers.
   */
  async function resumeTurn({
    userId,
    sessionId,
    turnId,
    resolution = null,
    authMode = null,
    approvalMode: requestedApprovalMode = null,
    retryRecovery = false,
  }) {
    rejectResumeApprovalModeOverride(requestedApprovalMode)
    if (!await deps.readSession({ userId, sessionId }) && authMode === 'local') {
      await claimLegacySession({ userId, sessionId, authMode })
    }
    const key = activeKey(userId, sessionId, turnId)
    const scope = { userId, sessionId, turnId }
    const started = await deps.lastEvent({ userId, sessionId, turnId, type: 'turn.started' })
    if (!started) throw new TurnEngineError('TURN_NOT_FOUND', 'turn not found', 404)
    let last = await deps.lastEvent({ userId, sessionId, turnId })
    if (isTerminalTurnEventType(last?.type)) {
      return {
        turn: await getTurn({ userId, sessionId, turnId }),
        scheduled: false,
        locallyActive: false,
        terminal: true,
      }
    }
    const recoveryState = await deps.readRecoveryState(scope)
    if ((last?.type === 'turn.blocked' || recoveryState?.status === 'dead_letter')
      && retryRecovery !== true) {
      const error = new TurnEngineError(
        'TURN_RECOVERY_DEAD_LETTER',
        recoveryState?.errorMessage || last?.payload?.message
          || 'automatic turn recovery stopped; repair the execution environment and retry explicitly',
        409,
      )
      error.retryable = false
      error.manualRetryable = true
      error.incompleteReason = last?.payload?.incompleteReason || 'recovery_blocked'
      error.missingRequirements = Array.isArray(last?.payload?.missingRequirements)
        ? last.payload.missingRequirements
        : ['execution_environment_repair', 'explicit_recovery_retry']
      error.recovery = recoveryState || {
        status: 'dead_letter',
        retryable: false,
        manualRetryable: true,
        errorCode: last?.payload?.code || 'TURN_RECOVERY_BLOCKED',
        errorMessage: last?.payload?.message || 'turn recovery is blocked',
      }
      throw error
    }
    const modelBinding = resolveModelBinding({
      userId,
      modelName: started.payload.modelName,
      modelProviderId: normalizeOptionalId(started.payload.modelProviderId),
      modelConfigRevision: normalizePositiveInteger(started.payload.modelConfigRevision),
      modelMode: normalizeModelMode(started.payload.modelMode),
      requirePersistedBinding: true,
    })
    const persistedEvents = await replayPersistedTurnEvents(deps.replayEvents, scope)
    const interruptionRecovery = modelInterruptionRecoveryState(
      persistedEvents,
      resolveModelInterruptionMaxAttempts(deps.env),
    )
    if (interruptionRecovery.exhausted) {
      const error = new TurnEngineError(
        'TURN_MODEL_RECOVERY_EXHAUSTED',
        `model recovery stopped after ${interruptionRecovery.attempts} interruptions without durable progress`,
        409,
      )
      error.retryable = false
      error.manualRetryable = true
      error.incompleteReason = 'recovery_attempts_exhausted'
      error.missingRequirements = [
        'model_service_available',
        'explicit_recovery_retry',
      ]
      error.attempts = interruptionRecovery.attempts
      error.causeCode = interruptionRecovery.causeCode
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
      const blockedEmitter = createEmitter({
        userId,
        sessionId,
        turnId,
        sequence: last.sequence + 1,
      })
      let blockedEvent
      try {
        blockedEvent = await blockedEmitter('turn.blocked', {
          code: error.code,
          error: failure,
          incompleteReason: error.incompleteReason,
          missingRequirements: error.missingRequirements,
          partialText: String(latestPersistedPayloadField(persistedEvents, 'partialText', '')),
          artifactIds: Array.isArray(latestPersistedPayloadField(persistedEvents, 'artifactIds', []))
            ? latestPersistedPayloadField(persistedEvents, 'artifactIds', [])
            : [],
          deliveryArtifactIds: Array.isArray(latestPersistedPayloadField(
            persistedEvents,
            'deliveryArtifactIds',
            [],
          ))
            ? latestPersistedPayloadField(persistedEvents, 'deliveryArtifactIds', [])
            : [],
          verifiedLocalFiles: Array.isArray(latestPersistedPayloadField(
            persistedEvents,
            'verifiedLocalFiles',
            [],
          ))
            ? latestPersistedPayloadField(persistedEvents, 'verifiedLocalFiles', [])
            : [],
          retainedLocalFiles: Array.isArray(latestPersistedPayloadField(
            persistedEvents,
            'retainedLocalFiles',
            [],
          ))
            ? latestPersistedPayloadField(persistedEvents, 'retainedLocalFiles', [])
            : [],
          iterations: Math.max(
            0,
            Number(latestPersistedPayloadField(persistedEvents, 'iterations', 0)) || 0,
          ),
          retryable: false,
          manualRetryable: true,
          recoveryStatus: 'dead_letter',
          attempts: error.attempts,
          causeCode: error.causeCode,
        })
      } finally {
        await blockedEmitter.close()
      }
      await deps.writeRecoveryFailure({
        ...scope,
        candidateVersion: recoveryCandidateVersion(blockedEvent),
        retryable: false,
        errorCode: error.code,
        errorMessage: error.message,
        now: blockedEvent.createdAt,
      })
      throw error
    }
    const latestFailedRetry = persistedEvents
      .filter((event) => event.type === 'turn.attempt' && event.payload?.reason === 'failed_retry')
      .at(-1)
    const failedRetryPending = Boolean(latestFailedRetry) && !persistedEvents.some((event) => (
      event.sequence > latestFailedRetry.sequence && isTerminalTurnEventType(event.type)
    ))
    let failedRetryActive = false
    if (failedRetryPending) {
      const failedRetryCheckpoint = await deps.runtimeCore.checkpoint.load(scope)
      failedRetryActive = isValidActiveFailedRetryAttempt(
        persistedEvents,
        latestFailedRetry,
        failedRetryCheckpoint,
      )
      if (!failedRetryActive) {
        const error = new TurnEngineError(
          'TURN_FAILED_RETRY_ATTEMPT_INVALID',
          'the persisted failed Turn retry is not bound to its failure and checkpoint',
          409,
        )
        error.retryable = false
        throw error
      }
    }
    const manualFailedRetryActive = failedRetryActive
      && latestFailedRetry.payload?.manualRetry === true
    const pause = pauseState(persistedEvents)
    const normalizedResolution = resolution == null ? null : normalizeTurnResolution(resolution)
    let resumeContext = pause.resumed ? {
      resolution: pause.resumed.payload.resolution,
      pausedSequence: pause.resumed.payload.pausedSequence,
    } : null
    const running = active.get(key)

    let directoryGrantVerified = false
    if (pause.pending) {
      if (!normalizedResolution) {
        return {
          turn: { ...await getTurn(scope), status: 'paused' },
          scheduled: false,
          locallyActive: false,
          terminal: false,
          paused: true,
        }
      }
      validateResolutionForPause(normalizedResolution, pause.paused)
      if (normalizedResolution.type === 'directory_authorization') {
        assertCurrentDirectoryGrant(userId, normalizedResolution)
        directoryGrantVerified = true
      }
      const resumeEmitter = createEmitter({
        userId,
        sessionId,
        turnId,
        sequence: last.sequence + 1,
      })
      let resumedEvent
      try {
        resumedEvent = await resumeEmitter('turn.resumed', {
          resolution: normalizedResolution,
          pausedSequence: pause.paused.sequence,
        })
      } finally {
        await resumeEmitter.close()
      }
      resumeContext = {
        resolution: normalizedResolution,
        pausedSequence: pause.paused.sequence,
      }
      last = resumedEvent
      if (running?.promise) await running.promise
      last = await deps.lastEvent({ userId, sessionId, turnId }) || last
      if (isTerminalTurnEventType(last?.type)) {
        return {
          turn: await getTurn(scope),
          scheduled: false,
          locallyActive: false,
          terminal: true,
        }
      }
    } else if (running) {
      return {
        turn: await getTurn(scope),
        scheduled: false,
        locallyActive: true,
        terminal: false,
      }
    }

    if (!directoryGrantVerified && resumeContext?.resolution?.type === 'directory_authorization') {
      assertCurrentDirectoryGrant(userId, resumeContext.resolution)
    }

    const emitter = createEmitter({ userId, sessionId, turnId, sequence: last.sequence + 1 })
    const persistedWorkspacePath = String(started.payload.workspacePath || '').trim() || null
    const persistedProjectDirectory = String(started.payload.projectDirectory || '').trim() || null
    const recoveredDirectory = persistedWorkspacePath
      ? await deps.resolveProjectDirectory({ userId, workspacePath: persistedWorkspacePath })
      : {
          workspacePath: null,
          projectDirectory: persistedProjectDirectory,
          defaultOutputDirectory: persistedProjectDirectory,
        }
    const scheduled = await schedule({
      userId,
      sessionId,
      turnId,
      turnStartedAt: started.createdAt,
      content: String(started.payload.content || ''),
      displayContent: String(started.payload.displayContent || started.payload.content || ''),
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
        || recoveredDirectory?.projectDirectory
        || null,
      failedRetryActive,
      manualFailedRetryActive,
      resumeContext,
      emitter,
    })
    if (!scheduled) await emitter.close()
    return {
      turn: await getTurn({ userId, sessionId, turnId }),
      scheduled,
      locallyActive: scheduled || active.has(key),
      terminal: false,
    }
  }

  return { resumeTurn }
}
