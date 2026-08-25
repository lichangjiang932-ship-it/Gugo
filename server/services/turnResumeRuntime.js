import { isTerminalTurnEventType } from './turnEventEmitter.js'
import {
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
  }) {
    rejectResumeApprovalModeOverride(requestedApprovalMode)
    if (!await deps.readSession({ userId, sessionId }) && authMode === 'local') {
      await claimLegacySession({ userId, sessionId, authMode })
    }
    const key = activeKey(userId, sessionId, turnId)
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
    const modelBinding = resolveModelBinding({
      userId,
      modelName: started.payload.modelName,
      modelProviderId: normalizeOptionalId(started.payload.modelProviderId),
      modelConfigRevision: normalizePositiveInteger(started.payload.modelConfigRevision),
      modelMode: normalizeModelMode(started.payload.modelMode),
      requirePersistedBinding: true,
    })
    const scope = { userId, sessionId, turnId }
    const persistedEvents = await replayPersistedTurnEvents(deps.replayEvents, scope)
    const latestFailedRetry = persistedEvents
      .filter((event) => event.type === 'turn.attempt' && event.payload?.reason === 'failed_retry')
      .at(-1)
    const failedRetryActive = Boolean(latestFailedRetry) && !persistedEvents.some((event) => (
      event.sequence > latestFailedRetry.sequence && isTerminalTurnEventType(event.type)
    ))
    const pause = pauseState(persistedEvents)
    const normalizedResolution = resolution == null ? null : normalizeTurnResolution(resolution)
    let resumeContext = pause.resumed ? {
      resolution: pause.resumed.payload.resolution,
      pausedSequence: pause.resumed.payload.pausedSequence,
    } : null
    const running = active.get(key)

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
        if (!hasSufficientDirectoryGrant(grants, normalizedResolution)) {
          throw new TurnEngineError(
            'TURN_DIRECTORY_GRANT_NOT_FOUND',
            'the requested directory authorization is not persisted for this user',
            403,
          )
        }
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
