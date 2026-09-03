import { randomUUID } from 'node:crypto'
import { getBoundTurnToolSpecs, runBoundTurnLoop } from './turnLoopBindingRuntime.js'
import { prepareBoundInlineSkillsForPrompt } from './inlineSkillPromptBindingRuntime.js'
import { publishTurnActivity } from './turnActivityBus.js'
import { dispatchHooks as dispatchHooksService } from './hooksService.js'
import { getApprovalMode } from './approvalSettingsStore.js'
import { recordEvolutionCanaryOutcome, resolveEvolutionCanaryAssignment } from './evolutionCanaryService.js'
import { createTurnExecutionToolContextRuntime } from './turnExecutionToolContextRuntime.js'
import { createTurnCancellationRuntime } from './turnCancellationRuntime.js'
import { createTurnCanaryOutcomeRuntime } from './turnCanaryOutcomeRuntime.js'
import { scheduleAutoMemoryExtraction } from './autoMemoryService.js'
import { listRuntimePluginStates } from './runtimePluginStateStore.js'
import { resolveToolImplementationRevisions as resolveCurrentToolImplementationRevisions } from './toolImplementationRevision.js'
import { getActiveRuntimePolicyProvenance } from '../core/runtimeCapabilityState.js'
import { getLocalFileAccessStatus, resolveTurnProjectDirectory, withTurnProjectDirectory } from './localFileAccessService.js'
import { logWarn, newTraceId, withLogContext } from '../utils/logger.js'
import { createTurnEventEmitter, isTerminalTurnEventType } from './turnEventEmitter.js'
import { createTurnModelRequestRunner } from './turnModelRequestRuntime.js'
import { TurnEngineError } from './turnResolutionRuntime.js'
import { createTurnStartRuntime, normalizeTurnModelMode as normalizeModelMode, normalizeTurnOptionalId as normalizeOptionalId } from './turnStartRuntime.js'
import { assembleTurnEnginePersistence } from './turnEnginePersistenceAssembly.js'
import { createTurnFailedRetryRuntime } from './turnFailedRetryRuntime.js'
import { createTurnTerminalOutcomeRuntime } from './turnTerminalOutcomeRuntime.js'
import { createTurnExecutionRuntime } from './turnExecutionRuntime.js'
import { createTurnSchedulingRuntime } from './turnSchedulingRuntime.js'
import { resolveTurnToolSpecs } from './turnToolSpecs.js'
import { createTurnResumeRuntime } from './turnResumeRuntime.js'
import { createTurnEngineShutdownRuntime } from './turnEngineShutdownRuntime.js'
import { projectRecoveryDeadLetterError } from './turnRecoveryProjection.js'
import { missingAttachmentBindingRuntime, missingAttachmentPreparationRuntime, missingAttachmentValidationRuntime } from './turnManagedAttachmentRuntime.js'
import {
  abortError,
  activeKey,
  MANUAL_RECOVERY_BLOCK_CODES,
  missingTurnModelRuntime,
  missingTurnPromptRuntime,
  normalizePositiveInteger,
  publicStatus,
  recoveryCandidateVersion,
  rejectResumeApprovalModeOverride,
  sessionKey,
} from './turnEnginePolicy.js'

export { TurnEngineError } from './turnResolutionRuntime.js'

export class TurnEngine {
  constructor(options = {}) {
    const {
      runLoop = runBoundTurnLoop,
    runModel = missingTurnModelRuntime,
    executeTool,
    eventEmitterFactory = createTurnEventEmitter,
    modelRequestRunnerFactory = createTurnModelRequestRunner,
    reconcileModelRequest = null,
    publishActivity = publishTurnActivity,
    idFactory = randomUUID,
    now = Date.now,
    toolSpecs = getBoundTurnToolSpecs(),
    directoryAuthorizationToolSpecs = toolSpecs,
    readApprovalMode = getApprovalMode,
    readRuntimePolicyProvenance = getActiveRuntimePolicyProvenance,
    preparePromptContext = missingTurnPromptRuntime,
    prepareInlineSkills = prepareBoundInlineSkillsForPrompt,
    resolveCanaryAssignment = resolveEvolutionCanaryAssignment,
    recordCanaryOutcome = recordEvolutionCanaryOutcome,
    resolveToolSpecs = resolveTurnToolSpecs,
    scheduleMemoryExtraction = scheduleAutoMemoryExtraction,
    runMemoryModel = missingTurnModelRuntime,
    getContextWindow = () => undefined,
    readFileAccessStatus = getLocalFileAccessStatus,
    resolveProjectDirectory = resolveTurnProjectDirectory,
    runWithProjectDirectory = withTurnProjectDirectory,
    attachmentRuntime = null,
    validateAttachments = attachmentRuntime?.validateAttachments
      || missingAttachmentValidationRuntime,
    bindAttachments = attachmentRuntime?.bindAttachments
      || missingAttachmentBindingRuntime,
    prepareAttachments = attachmentRuntime?.prepareAttachments
      || missingAttachmentPreparationRuntime,
    dispatchHooks = dispatchHooksService,
    resolveModelBinding = null,
    readRuntimePlugins = () => [],
    readRuntimePluginStates = listRuntimePluginStates,
    resolveToolImplementationRevisions = resolveCurrentToolImplementationRevisions,
      env = process.env,
    } = options
    const {
      persistence: persistenceBundle,
      ports: persistenceDeps,
    } = assembleTurnEnginePersistence(options)
    this.persistence = persistenceBundle
    this.deps = {
      runLoop, runModel, executeTool, appendEvent: persistenceDeps.appendEvent,
      publishActivity, lastEvent: persistenceDeps.lastEvent, replayEvents: persistenceDeps.replayEvents,
      readSession: persistenceDeps.readSession, sessionIdOccupied: persistenceDeps.sessionIdOccupied,
      claimSession: persistenceDeps.claimSession, writeSession: persistenceDeps.writeSession,
      readMessages: persistenceDeps.readMessages,
      readPreviousUserMessage: persistenceDeps.readPreviousUserMessage,
      writeMessage: persistenceDeps.writeMessage, idFactory, now, toolSpecs, directoryAuthorizationToolSpecs,
      readApprovalMode, readRuntimePolicyProvenance, preparePromptContext, prepareInlineSkills,
      resolveCanaryAssignment, recordCanaryOutcome,
      resolveToolSpecs, scheduleMemoryExtraction, runMemoryModel, env,
      getContextWindow, readFileAccessStatus, resolveProjectDirectory, runWithProjectDirectory,
      validateAttachments, bindAttachments, prepareAttachments,
      removeMessage: persistenceDeps.removeMessage,
      executionLeases: persistenceDeps.executionLeases,
      runtimeCore: persistenceDeps.runtimeCore,
      recordEventWriteFailure: persistenceDeps.recordEventWriteFailure,
      verifyEventCommit: persistenceDeps.verifyEventCommit,
      recordEmergencyFailure: persistenceDeps.recordEmergencyFailure,
      readRecoveryState: persistenceDeps.readRecoveryState,
      writeRecoveryFailure: persistenceDeps.writeRecoveryFailure,
      clearRecoveryState: persistenceDeps.clearRecoveryState,
      enqueueSteering: persistenceDeps.enqueueSteering,
      claimSteering: persistenceDeps.claimSteering,
      acknowledgeSteering: persistenceDeps.acknowledgeSteering,
      acknowledgeAppliedSteering: persistenceDeps.acknowledgeAppliedSteering,
      releaseSteering: persistenceDeps.releaseSteering,
      releaseStaleSteering: persistenceDeps.releaseStaleSteering,
      dispatchHooks,
      resolveModelBinding,
      readRuntimePlugins, readRuntimePluginStates, resolveToolImplementationRevisions,
      commitTurnStart: persistenceDeps.commitTurnStart,
      commitTurnCheckpoint: persistenceDeps.commitTurnCheckpoint,
      commitTurnBoundary: persistenceDeps.commitTurnBoundary,
      commitTurnFailedRetry: persistenceDeps.commitTurnFailedRetry,
      commitTurnFailedRetryRejection: persistenceDeps.commitTurnFailedRetryRejection,
      createEventWriteBehind: persistenceDeps.createEventWriteBehind,
      eventEmitterFactory,
      modelRequestRunnerFactory,
      reconcileModelRequest,
      readPendingModelRequest: persistenceDeps.readPendingModelRequest,
      readModelRequestResolution: persistenceDeps.readModelRequestResolution,
      commitPendingModelRequest: persistenceDeps.commitPendingModelRequest,
      supportsAtomicCheckpointState: persistenceDeps.supportsAtomicCheckpointState === true,
    }
    this.active = new Map()
    this.scheduling = new Set()
    this.startingSessions = new Map()
    this.eventWriters = new Set()
    this.shutdownWriterRetries = new Set()
    this.shutdownLeaseReleaseRetries = new Set()
    this.startIdleWaiters = new Set()
    this.closing = false
    this.closePromise = null
    this.executionToolContextRuntime = createTurnExecutionToolContextRuntime({
      readApprovalMode: (input) => this.deps.readApprovalMode(input),
      readFileAccessStatus: (input) => this.deps.readFileAccessStatus(input),
      resolveToolSpecs: (input) => this.deps.resolveToolSpecs(input),
    })
    this.startRuntime = createTurnStartRuntime({
      readSession: this.deps.readSession,
      sessionIdOccupied: this.deps.sessionIdOccupied,
      claimLegacySession: (scope) => this.#claimLegacySession(scope),
      lastEvent: this.deps.lastEvent,
      resolveModelBinding: (input) => this.#resolveModelBinding(input),
      resolveProjectDirectory: (input) => this.deps.resolveProjectDirectory(input),
      now: this.deps.now,
      writeSession: this.deps.writeSession,
      readMessages: this.deps.readMessages,
      writeMessage: this.deps.writeMessage,
      removeMessage: this.deps.removeMessage,
      validateAttachments: this.deps.validateAttachments,
      bindAttachments: this.deps.bindAttachments,
      createEmitter: (scope) => this.#createEmitter(scope),
      commitTurnStart: this.deps.commitTurnStart,
    })
    this.cancellationRuntime = createTurnCancellationRuntime({
      readSession: this.deps.readSession,
      claimLegacySession: (scope) => this.#claimLegacySession(scope),
      readActiveTurn: ({ userId, sessionId, turnId }) => (
        this.active.get(activeKey(userId, sessionId, turnId)) || null
      ),
      getTurn: (scope) => this.getTurn(scope),
      requestCancellation: (scope) => this.deps.runtimeCore.lease.requestCancellation(scope),
      abortActiveTurn: (running, error) => running.controller.abort(error),
      releaseApproval: (scope) => this.deps.runtimeCore.approval.release(scope),
      lastEvent: this.deps.lastEvent,
      acquireLease: (scope) => this.deps.runtimeCore.lease.acquire(scope),
      closeSteeringInbox: (scope) => this.deps.runtimeCore.lease.closeSteeringInbox(scope),
      replayEvents: this.deps.replayEvents,
      loadCheckpoint: (scope) => this.deps.runtimeCore.checkpoint.load(scope),
      now: this.deps.now,
      createEmitter: (scope) => this.#createEmitter(scope),
      commitTurnBoundary: this.deps.commitTurnBoundary,
      writeMessage: this.deps.writeMessage,
    })
    this.canaryOutcomeRuntime = createTurnCanaryOutcomeRuntime({ deps: {
      recordCanaryOutcome: (input) => this.deps.recordCanaryOutcome(input),
      env: this.deps.env,
    } })
    this.terminalOutcomeRuntime = createTurnTerminalOutcomeRuntime({
      now: this.deps.now,
      writeMessage: this.deps.writeMessage,
      commitTurnBoundary: this.deps.commitTurnBoundary,
      dispatchHooks: this.deps.dispatchHooks,
      scheduleMemoryExtraction: this.deps.scheduleMemoryExtraction,
      runMemoryModel: this.deps.runMemoryModel,
    })
    this.executionRuntime = createTurnExecutionRuntime({
      deps: this.deps,
      executionToolContextRuntime: this.executionToolContextRuntime,
      canaryOutcomeRuntime: this.canaryOutcomeRuntime,
      terminalOutcomeRuntime: this.terminalOutcomeRuntime,
    })
    this.scheduleTurn = createTurnSchedulingRuntime({
      active: this.active,
      scheduling: this.scheduling,
      leaseReleaseRetries: this.shutdownLeaseReleaseRetries,
      isClosing: () => this.closing,
      acquireLease: (scope) => this.deps.runtimeCore.lease.acquire(scope),
      runWithProjectDirectory: (scope, run) => this.deps.runWithProjectDirectory(scope, run),
      executeTurn: (context, signal) => this.executionRuntime(context, signal),
    })
    this.shutdownRuntime = createTurnEngineShutdownRuntime({
      active: this.active,
      eventWriters: this.eventWriters,
      writerRetries: this.shutdownWriterRetries,
      leaseReleaseRetries: this.shutdownLeaseReleaseRetries,
      startingSessions: this.startingSessions,
      startIdleWaiters: this.startIdleWaiters,
      getClosePromise: () => this.closePromise,
      setClosePromise: (promise) => { this.closePromise = promise },
      markClosing: () => { this.closing = true },
      createShutdownAbortError: () => abortError(
        'TURN_ENGINE_SHUTDOWN',
        'Turn execution paused for server shutdown',
      ),
    })
  }

  shutdown() {
    return this.shutdownRuntime()
  }

  async getTurn({ userId, sessionId, turnId }) {
    const key = activeKey(userId, sessionId, turnId)
    const last = await this.deps.lastEvent({ userId, sessionId, turnId })
    let running = this.active.has(key)
    if (!running) {
      try {
        running = !!await this.deps.runtimeCore.lease.isActive({ userId, sessionId, turnId })
      } catch (error) {
        logWarn('turn.status_lease_check', error, { userId, sessionId, turnId })
      }
    }
    let recovery = null
    if (last && !isTerminalTurnEventType(last.type)) {
      try {
        const state = await this.deps.readRecoveryState({ userId, sessionId, turnId })
        if (state) {
          recovery = {
            status: state.status,
            attemptCount: state.attemptCount,
            retryable: state.retryable,
            manualRetryable: last.type === 'turn.blocked'
              || MANUAL_RECOVERY_BLOCK_CODES.has(String(state.errorCode || '').trim()),
            firstFailedAt: state.firstFailedAt,
            lastFailedAt: state.lastFailedAt,
            nextRetryAt: state.nextRetryAt,
            error: {
              code: state.errorCode || 'TURN_RECOVERY_FAILED',
              message: state.errorMessage,
            },
          }
        }
      } catch (error) {
        // Recovery diagnostics must not hide the durable turn.
        logWarn('turn.recovery_diagnostics', error, { userId, sessionId, turnId })
      }
    }
    return last ? {
      sessionId,
      turnId,
      status: publicStatus(last, running),
      lastEvent: last,
      ...(recovery ? { recovery } : {}),
    } : null
  }

  async listEvents(scope) {
    return await this.deps.replayEvents(scope)
  }

  async getPendingModelRequestRecovery(scope) {
    return this.deps.readPendingModelRequest(scope)
  }

  async resolvePendingModelRequest(input) {
    return this.deps.commitPendingModelRequest(input)
  }

  async steerTurn({
    userId,
    sessionId,
    turnId,
    content,
    clientRequestId,
    authMode = null,
  } = {}) {
    if (!userId) throw new TurnEngineError('UNAUTHORIZED', 'Unauthorized', 401)
    if (!await this.deps.readSession({ userId, sessionId }) && authMode === 'local') {
      await this.#claimLegacySession({ userId, sessionId, authMode })
    }
    return this.deps.enqueueSteering({
      userId,
      sessionId,
      turnId,
      content,
      clientRequestId,
      now: this.deps.now(),
    })
  }

  async hasActiveSession({ userId, sessionId } = {}) {
    if (!userId || !sessionId) return false
    if (this.startingSessions.has(sessionKey(userId, sessionId))) return true
    const prefix = `${userId}\u0000${sessionId}\u0000`
    if ([...this.active.keys()].some((key) => key.startsWith(prefix))) return true
    if ([...this.scheduling].some((key) => key.startsWith(prefix))) return true
    try {
      return !!await this.deps.runtimeCore.lease.hasActiveSession({ userId, sessionId })
    } catch (error) {
      logWarn('turn.session_activity_check', error, { userId, sessionId })
      const wrapped = new TurnEngineError(
        'TURN_SESSION_ACTIVITY_CHECK_FAILED',
        'failed to verify whether the session has an active turn',
        503,
      )
      wrapped.cause = error
      throw wrapped
    }
  }

  async startTurn(args) {
    if (this.closing) throw new TurnEngineError('TURN_ENGINE_SHUTTING_DOWN', 'turn engine is shutting down', 503)
    // 一轮 turn 的关联上下文：userId/sessionId/turnId/traceId 沿异步链传递，
    // 期间模型代理、工具循环、压缩恢复等结构化日志都能按 turnId 串起来。
    const { userId, sessionId, turnId } = args || {}
    const resolvedTurnId = turnId || this.deps.idFactory()
    return withLogContext(
      { userId, sessionId, turnId: resolvedTurnId, traceId: newTraceId() },
      () => this.#startTurnInner({ ...args, turnId: resolvedTurnId }),
    )
  }

  async #startTurnInner(args = {}) {
    const startingKey = sessionKey(args.userId, args.sessionId)
    this.startingSessions.set(startingKey, (this.startingSessions.get(startingKey) || 0) + 1)
    try {
      const initialized = await this.startRuntime.initialize(args)
      const scheduled = await this.scheduleTurn({ ...initialized.execution, emitter: initialized.emitter })
      const { userId, sessionId, turnId } = initialized.scope
      if (!scheduled) await initialized.emitter.close()
      return await this.getTurn({ userId, sessionId, turnId })
    } finally {
      const remainingStarts = (this.startingSessions.get(startingKey) || 1) - 1
      if (remainingStarts > 0) this.startingSessions.set(startingKey, remainingStarts)
      else this.startingSessions.delete(startingKey)
      if (this.startingSessions.size === 0 && this.startIdleWaiters.size > 0) {
        for (const resolve of this.startIdleWaiters) resolve()
        this.startIdleWaiters.clear()
      }
    }
  }

  async resumeTurn(scope) {
    if (this.closing) throw new TurnEngineError('TURN_ENGINE_SHUTTING_DOWN', 'turn engine is shutting down', 503)
    rejectResumeApprovalModeOverride(scope?.approvalMode)
    if (scope?.retryFailed === true) return this.#retryFailedTurn(scope)
    const recovery = await this.deps.readRecoveryState(scope)
    const last = await this.deps.lastEvent(scope)
    const currentRecovery = last
      && recovery?.candidateVersion === recoveryCandidateVersion(last)
      ? recovery
      : null
    if ((currentRecovery?.status === 'dead_letter' || last?.type === 'turn.blocked')
      && scope?.retryRecovery !== true) {
      throw projectRecoveryDeadLetterError({ recovery: currentRecovery, event: last })
    }
    if (scope?.retryRecovery === true) await this.deps.clearRecoveryState(scope)
    const outcome = await this.recoverTurn(scope)
    if (outcome?.terminal || outcome?.scheduled || outcome?.locallyActive) {
      await this.deps.clearRecoveryState(scope)
    }
    return outcome.turn
  }

  async #retryFailedTurn(args = {}) {
    // KERNEL_BOUNDARY transition debt: retry orchestration lives in its own
    // narrow-port runtime; the engine only binds host callbacks.
    this.failedRetryRuntime ||= createTurnFailedRetryRuntime({
      deps: this.deps,
      claimLegacySession: (scope) => this.#claimLegacySession(scope),
      recoverTurn: (scope) => this.recoverTurn(scope),
      createEmitter: (input) => this.#createEmitter(input),
    })
    return this.failedRetryRuntime.retryFailedTurn(args)
  }

  /**
   * Startup recovery needs to distinguish "another process owns the lease"
   * from "this process scheduled the turn". The public resume response stays
   * unchanged; this explicit outcome is only used by durable recovery workers.
   */
  async recoverTurn(scope = {}) {
    // KERNEL_BOUNDARY transition debt: resume orchestration lives in its own
    // narrow-port runtime; the engine only binds host callbacks.
    this.resumeRuntime ||= createTurnResumeRuntime({
      deps: this.deps,
      claimLegacySession: (input) => this.#claimLegacySession(input),
      getTurn: (input) => this.getTurn(input),
      resolveModelBinding: (input) => this.#resolveModelBinding(input),
      active: this.active,
      createEmitter: (input) => this.#createEmitter(input),
      schedule: (context) => this.scheduleTurn(context),
    })
    return this.resumeRuntime.resumeTurn(scope)
  }

  async cancelTurn({ userId, sessionId, turnId, authMode = null }) {
    return this.cancellationRuntime.cancel({ userId, sessionId, turnId, authMode })
  }

  waitForTurn({ userId, sessionId, turnId }) {
    return this.active.get(activeKey(userId, sessionId, turnId))?.promise || Promise.resolve()
  }

  async #claimLegacySession({ userId, sessionId, authMode }) {
    try {
      return await this.deps.claimSession({ userId, sessionId, authMode })
    } catch (error) {
      const wrapped = new TurnEngineError('SESSION_CLAIM_FAILED', 'failed to claim legacy session', 500)
      wrapped.cause = error
      throw wrapped
    }
  }

  #createEmitter({ userId, sessionId, turnId, sequence }) {
    return this.deps.eventEmitterFactory({
      userId,
      sessionId,
      turnId,
      sequence,
      idFactory: this.deps.idFactory,
      now: this.deps.now,
      appendEvent: this.deps.appendEvent,
      verifyEventCommit: this.deps.verifyEventCommit,
      createEventWriteBehind: this.deps.createEventWriteBehind,
      recordEventWriteFailure: this.deps.recordEventWriteFailure,
      recordEmergencyFailure: this.deps.recordEmergencyFailure,
      createClosedError: () => new TurnEngineError(
        'TURN_EVENT_EMITTER_CLOSED',
        'turn event emitter is closed',
        503,
      ),
      onWriterOpen: (writer) => this.eventWriters.add(writer),
      onWriterClose: (writer) => this.eventWriters.delete(writer),
    })
  }

  #resolveModelBinding({
    userId,
    modelName,
    modelProviderId,
    modelConfigRevision,
    modelMode,
    requirePersistedBinding,
  }) {
    const fallback = {
      modelName: String(modelName || '').trim() || null,
      modelProviderId: normalizeOptionalId(modelProviderId),
      modelConfigRevision: normalizePositiveInteger(modelConfigRevision),
      env: null,
    }
    if (typeof this.deps.resolveModelBinding !== 'function') return fallback
    const binding = this.deps.resolveModelBinding({
      userId,
      providerId: fallback.modelProviderId || '',
      modelName: fallback.modelName || '',
      configRevision: fallback.modelConfigRevision,
      modelMode: normalizeModelMode(modelMode),
      env: this.deps.env,
      requirePersistedBinding,
    })
    return {
      modelName: String(binding?.modelName || '').trim() || null,
      modelProviderId: normalizeOptionalId(binding?.providerId),
      modelConfigRevision: normalizePositiveInteger(binding?.configRevision),
      env: binding?.env && typeof binding.env === 'object' ? binding.env : null,
    }
  }
}
