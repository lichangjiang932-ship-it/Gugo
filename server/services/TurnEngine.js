import { randomUUID } from 'node:crypto'
import { normalizeModelUsage } from '../../shared/modelUsage.js'
import {
  getBoundTurnToolSpecs,
  runBoundTurnLoop,
} from './turnLoopBindingRuntime.js'
import { prepareBoundInlineSkillsForPrompt } from './inlineSkillPromptBindingRuntime.js'
import { publishTurnActivity } from './turnActivityBus.js'
import { dispatchHooks as dispatchHooksService } from './hooksService.js'
import { getApprovalMode } from './approvalSettingsStore.js'
import {
  buildAssistantModelContext,
  expandStoredMessages,
  extractRetainedLocalFiles,
  extractVerifiedLocalFiles,
  selectAttachmentIdsForModelRequest,
  selectStoredMessagesAfterCompaction,
} from './turnMessageContext.js'
import {
  recordEvolutionCanaryOutcome,
  resolveEvolutionCanaryAssignment,
} from './evolutionCanaryService.js'
import { createTurnExecutionToolContextRuntime } from './turnExecutionToolContextRuntime.js'
import { createTurnCancellationRuntime } from './turnCancellationRuntime.js'
import { createTurnCanaryOutcomeRuntime } from './turnCanaryOutcomeRuntime.js'
import { scheduleAutoMemoryExtraction } from './autoMemoryService.js'
import { listRuntimePluginStates } from './runtimePluginStateStore.js'
import {
  assertTurnExecutionEnvironmentCompatible,
  createTurnExecutionEnvironmentSnapshot,
  TURN_EXECUTION_ENVIRONMENT_MISSING,
  TURN_MODEL_BINDING_DRIFT,
  TURN_PERMISSION_CONTEXT_DRIFT,
  TURN_POLICY_CONTEXT_DRIFT,
  TURN_RUNTIME_PLUGIN_RELEASE_DRIFT,
  TURN_RUNTIME_PLUGIN_RELEASE_UNPINNED,
  TURN_TOOL_CATALOG_DRIFT,
  TURN_TOOL_IMPLEMENTATION_DRIFT,
} from './turnExecutionEnvironment.js'
import {
  resolveToolImplementationRevisions as resolveCurrentToolImplementationRevisions,
  TOOL_IMPLEMENTATION_REVISION_UNAVAILABLE,
} from './toolImplementationRevision.js'
import { getActiveRuntimePolicyProvenance } from '../core/runtimeCapabilityState.js'
import {
  getLocalFileAccessStatus,
  resolveTurnProjectDirectory,
  withTurnProjectDirectory,
} from './localFileAccessService.js'
import { logWarn, newTraceId, withLogContext } from '../utils/logger.js'
import {
  checkpointMessagesForTurn,
  latestLegacyCheckpoint,
  normalizeResolutionPath,
  recoveryAttemptAfterCheckpoint,
  storedCheckpointEvent,
} from './turnRecoveryProjection.js'
import {
  createTerminalPersistenceFailure,
  createTurnEventEmitter,
  findEventPersistenceFailure,
  isTerminalTurnEventType,
  TURN_TERMINAL_PERSISTENCE_FAILURE_CODE,
} from './turnEventEmitter.js'
import {
  deliveryArtifactFields,
  finalClarificationText,
  normalizeArtifactIds,
  normalizeTurnFailure as normalizeFailure,
  optionalDeliveryArtifactIds,
  PUBLIC_TURN_INCOMPLETE,
  PUBLIC_TURN_INTERRUPTED,
  publicIncompleteText,
  sameArtifactIds,
} from './turnTerminalProjection.js'
import {
  addTurnModelUsage as addModelUsage,
  normalizePromptTokenEstimate,
} from './turnModelUsageProjection.js'
import {
  createChatOnlyToolExecutionError,
  createTurnModelRequestRunner,
} from './turnModelRequestRuntime.js'
import {
  createTurnResolutionRuntime,
  TurnEngineError,
} from './turnResolutionRuntime.js'
import {
  createTurnStartRuntime,
  normalizeTurnModelMode as normalizeModelMode,
  normalizeTurnOptionalId as normalizeOptionalId,
} from './turnStartRuntime.js'
import { assembleTurnEnginePersistence } from './turnEnginePersistenceAssembly.js'
import { createTurnFailedRetryRuntime } from './turnFailedRetryRuntime.js'
import { resolveTurnToolSpecs } from './turnToolSpecs.js'
import { createTurnResumeRuntime } from './turnResumeRuntime.js'
import {
  missingAttachmentBindingRuntime,
  missingAttachmentPreparationRuntime,
  missingAttachmentValidationRuntime,
} from './turnManagedAttachmentRuntime.js'

export { TurnEngineError } from './turnResolutionRuntime.js'

const MANUAL_RECOVERY_BLOCK_CODES = new Set([
  TURN_EXECUTION_ENVIRONMENT_MISSING,
  TURN_MODEL_BINDING_DRIFT,
  TURN_PERMISSION_CONTEXT_DRIFT,
  TURN_POLICY_CONTEXT_DRIFT,
  TURN_TOOL_CATALOG_DRIFT,
  TURN_TOOL_IMPLEMENTATION_DRIFT,
  TURN_RUNTIME_PLUGIN_RELEASE_DRIFT,
  TURN_RUNTIME_PLUGIN_RELEASE_UNPINNED,
  TOOL_IMPLEMENTATION_REVISION_UNAVAILABLE,
  'PLUGIN_RELEASE_CORRUPT',
  'SIDE_EFFECT_LEDGER_CONFLICT',
  'SIDE_EFFECT_LEDGER_OUTCOME_INVALID',
  'SIDE_EFFECT_OUTCOME_UNKNOWN',
  'MODEL_REQUEST_OUTCOME_UNKNOWN',
  'MODEL_REQUEST_CONTEXT_DRIFT',
])
function rejectResumeApprovalModeOverride(value) {
  if (value === null || value === undefined) return
  throw new TurnEngineError(
    'TURN_APPROVAL_MODE_OVERRIDE_FORBIDDEN',
    'approvalMode cannot be changed while resuming a turn; the persisted turn mode is restored',
    409,
  )
}

const ATOMIC_CHECKPOINT_UNSUPPORTED_CODE = 'TURN_ATOMIC_CHECKPOINT_UNSUPPORTED'
const ATOMIC_CHECKPOINT_COMMIT_MISMATCH_CODE = 'TURN_ATOMIC_CHECKPOINT_COMMIT_MISMATCH'
function activeKey(userId, sessionId, turnId) {
  return `${userId}\u0000${sessionId}\u0000${turnId}`
}

function sessionKey(userId, sessionId) {
  return `${userId}\u0000${sessionId}`
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const {
  applyToCheckpoint: checkpointStateForResolution,
  publicStatus,
} = createTurnResolutionRuntime({ normalizePath: normalizeResolutionPath })

function normalizePromptContextIds(values, limit = 64) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeOptionalId(value))
    .filter(Boolean))]
    .slice(0, limit)
}

function normalizeCanaryAssignmentSnapshot(value) {
  if (!isRecord(value)) return null
  const id = normalizeOptionalId(value.id)
  const releaseId = normalizeOptionalId(value.releaseId)
  const variant = String(value.variant || '').trim()
  if (!id || !releaseId || !['baseline', 'candidate'].includes(variant)) return null
  return {
    id,
    releaseId,
    variant,
    decisionReason: normalizeOptionalId(value.decisionReason),
    target: normalizeOptionalId(value.target),
  }
}

function normalizePromptContextSnapshot(value) {
  if (!isRecord(value)) return null
  return {
    version: 1,
    effectiveAgentId: normalizeOptionalId(value.effectiveAgentId),
    skillIds: normalizePromptContextIds(value.skillIds, 32),
    memoryIds: normalizePromptContextIds(value.memoryIds),
    pluginPromptBlockIds: normalizePromptContextIds(value.pluginPromptBlockIds),
    canaryAssignment: normalizeCanaryAssignmentSnapshot(value.canaryAssignment),
  }
}

function isManualRecoveryBlock(error) {
  const code = String(error?.code || '').trim()
  if (code === 'SIDE_EFFECT_OUTCOME_UNKNOWN') {
    return error?.unsafeToReplay === true
      && error?.retryable === false
      && error?.requiresUserVerification === true
  }
  return error?.unsafeToReplay === true
    && error?.retryable === false
    && MANUAL_RECOVERY_BLOCK_CODES.has(code)
}

function recoveryCandidateVersion(event) {
  return [event.sequence, event.type, event.createdAt].join(':')
}

function normalizePositiveInteger(value) {
  const normalized = Number(value)
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null
}

function abortError(code, message) {
  return Object.assign(new Error(message), { name: 'AbortError', code })
}

function isExplicitTurnCancellation(signal, error) {
  if (signal?.aborted) return true
  const codes = [error?.code, error?.cause?.code, signal?.reason?.code]
    .map((value) => String(value || '').trim().toUpperCase())
  return codes.includes('TURN_CANCEL_REQUESTED') || codes.includes('USER_STOPPED')
}

function isTemporaryTurnEvidence(message, turnId) {
  return message?.id === `${turnId}:assistant`
    && message?.modelContext?.turnEvidence === true
}

function lostTurnLease(signal, error = null) {
  const terminalCodes = new Set(['TURN_LEASE_LOST', 'TURN_ENGINE_SHUTDOWN', 'TURN_ALREADY_TERMINAL'])
  const hasTerminalCode = (candidate) => {
    const seen = new Set()
    let current = candidate
    for (let depth = 0; current && depth < 8 && !seen.has(current); depth += 1) {
      if (terminalCodes.has(String(current?.code || '').trim().toUpperCase())) return true
      seen.add(current)
      current = current?.cause
    }
    return false
  }
  return hasTerminalCode(error) || hasTerminalCode(signal?.reason)
}

function missingTurnModelRuntime() {
  const error = new TurnEngineError(
    'TURN_MODEL_RUNTIME_NOT_CONFIGURED',
    'TurnEngine requires its host to provide a model runtime',
    503,
  )
  error.retryable = false
  throw error
}

function missingTurnPromptRuntime() {
  const error = new TurnEngineError(
    'TURN_PROMPT_RUNTIME_NOT_CONFIGURED',
    'TurnEngine requires its host to provide a prompt runtime',
    503,
  )
  error.retryable = false
  throw error
}

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
  }

  shutdown() {
    if (this.closePromise) return this.closePromise
    this.closing = true
    const attempt = (async () => {
      if (this.startingSessions.size > 0) {
        await new Promise((resolve) => this.startIdleWaiters.add(resolve))
      }
      const retryWriters = new Set(this.shutdownWriterRetries)
      const retryLeaseReleases = new Set(this.shutdownLeaseReleaseRetries)
      const writers = new Set([...retryWriters, ...this.eventWriters])
      const active = [...this.active.values()]
      for (const entry of active) {
        if (!entry.controller.signal.aborted) {
          entry.controller.abort(abortError('TURN_ENGINE_SHUTDOWN', 'Turn execution paused for server shutdown'))
        }
      }
      const activeOutcomes = await Promise.allSettled(
        active.map((entry) => entry.promise).filter(Boolean),
      )
      const pendingLeaseReleases = [...retryLeaseReleases]
      const leaseReleaseOutcomes = await Promise.allSettled(
        pendingLeaseReleases.map((release) => Promise.resolve().then(release)),
      )
      for (let index = 0; index < pendingLeaseReleases.length; index += 1) {
        const release = pendingLeaseReleases[index]
        if (leaseReleaseOutcomes[index]?.status === 'fulfilled') {
          this.shutdownLeaseReleaseRetries.delete(release)
        } else {
          this.shutdownLeaseReleaseRetries.add(release)
        }
      }
      for (const writer of this.eventWriters) writers.add(writer)
      const pendingWriters = [...writers]
      const writerOutcomes = await Promise.allSettled(pendingWriters.map((writer) => (
        Promise.resolve().then(() => (
          retryWriters.has(writer) && typeof writer.flush === 'function'
            ? writer.flush()
            : typeof writer.close === 'function' ? writer.close() : writer.flush()
        ))
      )))
      for (let index = 0; index < pendingWriters.length; index += 1) {
        const writer = pendingWriters[index]
        if (writerOutcomes[index]?.status === 'fulfilled') {
          this.eventWriters.delete(writer)
          this.shutdownWriterRetries.delete(writer)
        } else {
          this.shutdownWriterRetries.add(writer)
        }
      }
      const failures = [...new Set(
        [...activeOutcomes, ...leaseReleaseOutcomes, ...writerOutcomes]
          .filter((outcome) => outcome.status === 'rejected')
          .map((outcome) => outcome.reason),
      )]
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to shut down TurnEngine cleanly')
      }
    })()
    this.closePromise = attempt
    void attempt.then(
      () => {},
      () => {
        if (this.closePromise === attempt) this.closePromise = null
      },
    )
    return attempt
  }

  async getTurn({ userId, sessionId, turnId }) {
    const key = activeKey(userId, sessionId, turnId)
    const last = await this.deps.lastEvent({ userId, sessionId, turnId })
    let running = this.active.has(key)
    if (!running) {
      try { running = !!await this.deps.runtimeCore.lease.isActive({ userId, sessionId, turnId }) } catch { /* advisory */ }
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
      } catch { /* recovery diagnostics must not hide the durable turn */ }
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
    try { return !!await this.deps.runtimeCore.lease.hasActiveSession({ userId, sessionId }) } catch { return false }
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
      const scheduled = await this.#schedule({ ...initialized.execution, emitter: initialized.emitter })
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
    if ((recovery?.status === 'dead_letter' || last?.type === 'turn.blocked')
      && scope?.retryRecovery !== true) {
      const error = new TurnEngineError(
        'TURN_RECOVERY_DEAD_LETTER',
        recovery?.errorMessage || last?.payload?.message
          || 'automatic turn recovery stopped; repair the execution environment and retry explicitly',
        409,
      )
      error.recovery = recovery || {
        status: 'dead_letter',
        retryable: false,
        manualRetryable: true,
        errorCode: last?.payload?.code || 'TURN_RECOVERY_BLOCKED',
        errorMessage: last?.payload?.message || 'turn recovery is blocked',
      }
      throw error
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
      schedule: (context) => this.#schedule(context),
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

  async #schedule(context) {
    if (this.closing) return false
    const key = activeKey(context.userId, context.sessionId, context.turnId)
    if (this.active.has(key) || this.scheduling.has(key)) return false
    this.scheduling.add(key)
    const scope = { userId: context.userId, sessionId: context.sessionId, turnId: context.turnId }
    try {
      const lease = await this.deps.runtimeCore.lease.acquire(scope)
      if (!lease) return false
      if (this.closing || this.active.has(key)) {
        await lease.release()
        return false
      }
      const { controller, executionLease = null } = lease
      const releaseLease = () => lease.release()
      const entry = { controller, executionLease, promise: null, releaseLease, emitter: context.emitter }
      this.active.set(key, entry)
      entry.promise = Promise.resolve()
        .then(() => this.deps.runWithProjectDirectory({
          userId: context.userId,
          projectDirectory: context.projectDirectory,
          defaultOutputDirectory: context.defaultOutputDirectory,
        }, () => this.#execute({ ...context, executionLease }, controller.signal)))
        .finally(async () => {
          let failure = null
          let failed = false
          try {
            await context.emitter?.close?.()
          } catch (error) {
            failure = error
            failed = true
          }
          try {
            await releaseLease?.()
            this.shutdownLeaseReleaseRetries.delete(releaseLease)
          } catch (error) {
            this.shutdownLeaseReleaseRetries.add(releaseLease)
            failure = error
            failed = true
          } finally {
            if (this.active.get(key) === entry) this.active.delete(key)
          }
          if (failed) throw failure
        })
      entry.promise.catch(() => {})
      return true
    } finally {
      this.scheduling.delete(key)
    }
  }

  async #execute({
    userId,
    sessionId,
    turnId,
    turnStartedAt,
    content,
    displayContent,
    modelName,
    modelProviderId,
    modelConfigRevision,
    modelRuntimeEnv,
    modelMode,
    agentId,
    skillIds,
    skillDefinitions,
    toolsConfig,
    intentMode,
    approvalMode,
    failedRetryActive = false,
    resumeContext,
    emitter,
    executionLease = null,
  }, signal) {
    if (signal.aborted) {
      if (!lostTurnLease(signal)) {
        const cancelledAt = this.deps.now()
        const cancellationReason = signal.reason?.message || 'Cancelled by user'
        const cancellationMessage = {
          id: `${turnId}:assistant`,
          userId,
          sessionId,
          role: 'assistant',
          content: cancellationReason,
          modelContext: {
            ...buildAssistantModelContext({
              turnId,
              checkpointMessages: [],
              baselineToolCallIds: new Set(),
              userId,
              verifiedLocalFiles: [],
              retainedLocalFiles: [],
              artifactIds: [],
              deliveryArtifactIds: [],
              iterations: 0,
              turnStartedAt,
              turnCompletedAt: cancelledAt,
            }),
            turnEvidence: true,
            evidenceState: 'cancelled',
          },
          createdAt: cancelledAt,
          updatedAt: cancelledAt,
        }
        const atomicTurnBoundary = typeof this.deps.commitTurnBoundary === 'function'
        await emitter('turn.cancelled', {
          reason: cancellationReason,
          verifiedLocalFiles: [],
          retainedLocalFiles: [],
        }, {
          commitEvent: atomicTurnBoundary
            ? ({ event }) => this.deps.commitTurnBoundary({
                userId,
                event,
                message: cancellationMessage,
                executionLease,
              })
            : null,
        })
        if (!atomicTurnBoundary) {
          try {
            await this.deps.writeMessage(cancellationMessage)
          } catch {
            // Legacy injected stores retain the event-authoritative behavior.
          }
        }
      }
      return
    }
    const checkpointScope = { userId, sessionId, turnId }
    const effectiveTurnStartedAt = Number.isFinite(Number(turnStartedAt))
      ? Math.max(0, Number(turnStartedAt))
      : this.deps.now()
    const storedCheckpoint = storedCheckpointEvent(
      await this.deps.runtimeCore.checkpoint.load(checkpointScope),
    )
    const checkpoint = storedCheckpoint
      || await latestLegacyCheckpoint(this.deps.replayEvents, checkpointScope)
    let latestCheckpointSequence = Number.isInteger(checkpoint?.sequence) ? checkpoint.sequence : null
    const resolvedCheckpointState = checkpointStateForResolution(checkpoint?.payload?.state, resumeContext)
    // A failed-retry attempt resumes the durable conversation/tool state, not
    // the previous retryable terminal projection. Replaying final.incomplete
    // here would return the same failure without making another model call.
    const restoredCheckpointState = failedRetryActive && resolvedCheckpointState?.final
      ? { ...resolvedCheckpointState, final: null }
      : resolvedCheckpointState
    const steeringOwnerId = normalizeOptionalId(this.deps.runtimeCore.lease.ownerId)
    const steeringScope = { userId, sessionId, turnId, ownerId: steeringOwnerId }
    if (steeringOwnerId) {
      const appliedSteeringIds = Array.isArray(checkpoint?.payload?.state?.appliedSteeringIds)
        ? checkpoint.payload.state.appliedSteeringIds
        : []
      await this.deps.acknowledgeAppliedSteering({
        ...steeringScope,
        steeringIds: appliedSteeringIds,
        now: this.deps.now(),
      })
      await this.deps.releaseStaleSteering({ ...steeringScope, now: this.deps.now() })
    }
    let pendingRecoveryAttempt = await recoveryAttemptAfterCheckpoint(
      this.deps.replayEvents,
      { userId, sessionId, turnId },
      checkpoint,
    )
    const storedMessages = (await this.deps.readMessages({ userId, sessionId, limit: 500, recent: true }))
      .filter((message) => !isTemporaryTurnEvidence(message, turnId))
      .filter((message) => !(
        message?.id === `${turnId}:assistant`
          && message?.modelContext?.paused === true
      ))
      .filter((message) => !(
        message?.modelContext?.liveSteering === true
          && message?.modelContext?.turnId === turnId
      ))
      .map((message) => message.id === `${turnId}:user`
        ? { ...message, content }
        : message)
    const currentUserMessage = storedMessages.find((message) => message.id === `${turnId}:user`)
    const previousUserPrompt = (await this.deps.readPreviousUserMessage({
      userId,
      sessionId,
      messageId: `${turnId}:user`,
    }))?.content || ''
    const managedAttachments = Array.isArray(currentUserMessage?.modelContext?.attachments)
      ? currentUserMessage.modelContext.attachments
      : []
    const restoredPromptContextSnapshot = normalizePromptContextSnapshot(
      restoredCheckpointState?.promptContextSnapshot,
    )
    let canaryAssignment = restoredPromptContextSnapshot?.canaryAssignment || null
    let promptContext = {
      messages: [],
      effectiveAgentId: restoredPromptContextSnapshot?.effectiveAgentId || agentId,
      skillIds: restoredPromptContextSnapshot?.skillIds || skillIds,
      memoryIds: restoredPromptContextSnapshot?.memoryIds || [],
      pluginPromptBlockIds: restoredPromptContextSnapshot?.pluginPromptBlockIds || [],
      compactionArchiveId: null,
      compactionBoundary: null,
      canaryAssignment,
    }
    if (!restoredPromptContextSnapshot) {
      try {
        canaryAssignment = await this.deps.resolveCanaryAssignment({
          userId,
          sessionId,
          turnId,
          env: this.deps.env,
          now: this.deps.now(),
        })
      } catch (error) {
        // Canary routing is optional and must fail closed to the baseline prompt.
        try { logWarn('evolution.canary.resolve', error, { userId, sessionId, turnId }) } catch { /* optional */ }
      }
      try {
        promptContext = await this.deps.preparePromptContext({
          userId,
          agentId,
          skillIds,
          skillDefinitions,
          sessionId,
          recentMessages: storedMessages,
          includeRecentTranscript: false,
          query: content,
          canaryAssignment,
          env: this.deps.env,
        }) || promptContext
      } catch {
        // Optional memory/agent/skill/canary context must never prevent a turn from running.
        canaryAssignment = null
      }
    }
    const promptContextSnapshot = restoredPromptContextSnapshot || normalizePromptContextSnapshot({
      effectiveAgentId: promptContext.effectiveAgentId || agentId,
      skillIds: promptContext.skillIds,
      memoryIds: promptContext.memoryIds,
      pluginPromptBlockIds: promptContext.pluginPromptBlockIds,
      canaryAssignment: canaryAssignment || promptContext.canaryAssignment,
    })
    const selectedStoredMessages = selectStoredMessagesAfterCompaction(
      storedMessages,
      promptContext.compactionBoundary,
    )
    const promptStoredMessages = currentUserMessage
      && !selectedStoredMessages.some((message) => message?.id === currentUserMessage.id)
      ? [...selectedStoredMessages, currentUserMessage]
      : selectedStoredMessages
    const historyMessages = expandStoredMessages(promptStoredMessages)
    const messages = [
      ...(Array.isArray(promptContext.messages) ? promptContext.messages : []),
      ...historyMessages,
    ]
    const toolResolutionMessages = Array.isArray(restoredCheckpointState?.messages)
      ? restoredCheckpointState.messages
      : messages
    const attachmentIdsForFirstModelRequest = selectAttachmentIdsForModelRequest(messages, {
      currentAttachmentIds: managedAttachments.map((attachment) => attachment.id),
      prompt: content,
    })
    const {
      normalizedModelMode,
      chatOnlyMode,
      effectiveToolsConfig,
      effectiveIntentMode,
      effectiveSkillIds,
      activeSkillId,
      currentApprovalMode,
      effectiveApprovalMode,
      resolvedToolSpecs,
      toolResolutionDecision,
      modelToolFileAccessStatus,
    } = await this.executionToolContextRuntime.resolve({
      userId,
      content,
      modelMode,
      toolsConfig,
      intentMode,
      approvalMode,
      resumeResolution: resumeContext?.resolution,
      restoredCheckpointState,
      promptContextSkillIds: promptContextSnapshot?.skillIds || promptContext.skillIds,
      fallbackSkillIds: skillIds,
      toolResolutionMessages,
      baseToolSpecs: this.deps.toolSpecs,
      directoryAuthorizationToolSpecs: this.deps.directoryAuthorizationToolSpecs,
    })
    const baselineToolCallIds = new Set()
    let checkpointMessages = checkpointMessagesForTurn(restoredCheckpointState, { content })
    let checkpointArtifactIds = normalizeArtifactIds(restoredCheckpointState?.artifactIds)
    let checkpointDeliveryArtifactIds = optionalDeliveryArtifactIds(restoredCheckpointState)
    let checkpointIterations = Math.max(0, Number(restoredCheckpointState?.iterations) || 0)
    let checkpointRecovery = restoredCheckpointState?.recovery || null
    let latestModelUsage = normalizeModelUsage(restoredCheckpointState?.latestModelUsage)
    let turnModelUsage = normalizeModelUsage(restoredCheckpointState?.turnModelUsage)
      || latestModelUsage
    let latestEstimatedPromptTokens = normalizePromptTokenEstimate(
      restoredCheckpointState?.latestEstimatedPromptTokens,
    )
    // Evolution telemetry stays host-owned: recording is optional and must
    // never fail the turn. Live run context binds at call time because usage
    // counters and the canary assignment mutate during execution.
    const recordCanaryTerminal = (
      terminalState,
      errorCode = null,
      completedAt = this.deps.now(),
      evaluationOutput = '',
    ) => this.canaryOutcomeRuntime({
      canaryAssignment,
      userId,
      sessionId,
      turnId,
      effectiveTurnStartedAt,
      turnModelUsage,
      latestModelUsage,
      modelProviderId,
      modelName,
      modelConfigRevision,
      evaluationInput: content,
      terminalState,
      errorCode,
      completedAt,
      evaluationOutput,
    })
    let streamedAssistantText = String(
      pendingRecoveryAttempt?.assistantText || restoredCheckpointState?.retryAssistantText || '',
    )
    const verifiedLocalFilesAt = (verifiedAt = this.deps.now()) => extractVerifiedLocalFiles(
      checkpointMessages,
      { userId, baselineToolCallIds, verifiedAt },
    )
    const retainedLocalFilesAt = (retainedAt = this.deps.now(), verifiedLocalFiles = []) => {
      const verifiedIds = new Set((Array.isArray(verifiedLocalFiles) ? verifiedLocalFiles : [])
        .map((file) => String(file?.id || '').trim())
        .filter(Boolean))
      return extractRetainedLocalFiles(checkpointMessages, {
        userId,
        baselineToolCallIds,
        retainedAt,
      }).filter((file) => !verifiedIds.has(String(file?.id || '').trim()))
    }
    const atomicTurnBoundary = typeof this.deps.commitTurnBoundary === 'function'
    const createTurnEvidenceMessage = ({
      state,
      text,
      artifactIds,
      deliveryArtifactIds,
      iterations,
      error = null,
      serverLastSequence = null,
      verifiedLocalFiles = null,
      retainedLocalFiles = null,
      blockedRecovery = null,
      writtenAt = this.deps.now(),
    }) => {
      const evidenceText = String(text || '').trim() || error?.message || 'Turn execution did not complete.'
      const evidenceArtifacts = normalizeArtifactIds(artifactIds)
      const evidenceIterations = Math.max(0, Number(iterations) || 0)
      const evidenceVerifiedLocalFiles = Array.isArray(verifiedLocalFiles)
        ? verifiedLocalFiles
        : verifiedLocalFilesAt(writtenAt)
      const evidenceRetainedLocalFiles = Array.isArray(retainedLocalFiles)
        ? retainedLocalFiles
        : retainedLocalFilesAt(writtenAt, evidenceVerifiedLocalFiles)
      const recoveryKind = state === 'blocked' && blockedRecovery?.requiresUserVerification === true
        ? String(blockedRecovery.recoveryKind || '').trim()
        : ''
      const recoveryToolCallId = recoveryKind === 'side_effect_outcome_unknown'
        ? normalizeOptionalId(blockedRecovery.toolCallId)
        : null
      const recoveryModelRequestId = recoveryKind === 'model_request_outcome_unknown'
        ? normalizeOptionalId(blockedRecovery.modelRequestId)
        : null
      const evidenceRecovery = ['side_effect_outcome_unknown', 'model_request_outcome_unknown'].includes(recoveryKind)
        ? {
            recoveryKind,
            requiresUserVerification: true,
            ...(recoveryToolCallId ? { toolCallId: recoveryToolCallId } : {}),
            ...(recoveryModelRequestId ? { modelRequestId: recoveryModelRequestId } : {}),
            recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' },
          }
        : null
      return {
        id: `${turnId}:assistant`,
        userId,
        sessionId,
        role: 'assistant',
        content: evidenceText,
        modelContext: {
          ...buildAssistantModelContext({
            turnId,
            checkpointMessages,
            baselineToolCallIds,
            userId,
            verifiedLocalFiles: evidenceVerifiedLocalFiles,
            retainedLocalFiles: evidenceRetainedLocalFiles,
            artifactIds: evidenceArtifacts,
            deliveryArtifactIds,
            iterations: evidenceIterations,
            pluginPromptBlockIds: promptContextSnapshot?.pluginPromptBlockIds,
            compactionRecovery: checkpointRecovery,
            usage: latestModelUsage,
            turnModelUsage,
            estimatedPromptTokens: latestEstimatedPromptTokens,
            turnStartedAt: effectiveTurnStartedAt,
            turnCompletedAt: writtenAt,
          }),
          turnEvidence: true,
          evidenceState: state,
          ...(Number.isInteger(serverLastSequence) && serverLastSequence >= 0
            ? { serverLastSequence }
            : {}),
          ...(error ? { error } : {}),
          ...(evidenceRecovery ? { recovery: evidenceRecovery } : {}),
        },
        createdAt: writtenAt,
        updatedAt: writtenAt,
      }
    }
    const persistTurnEvidence = async (options) => {
      const message = createTurnEvidenceMessage(options)
      await this.deps.writeMessage(message)
      return message.content
    }
    const commitBoundaryEvent = ({ event, message }) => this.deps.commitTurnBoundary({
      userId,
      event,
      message,
      executionLease,
    })
    const evidenceBoundaryOptions = (options, {
      legacyBeforeAppend = false,
    } = {}) => {
      if (atomicTurnBoundary) {
        return {
          commitEvent: ({ event }) => commitBoundaryEvent({
            event,
            message: createTurnEvidenceMessage({
              ...options,
              serverLastSequence: event.sequence,
            }),
          }),
        }
      }
      if (legacyBeforeAppend) {
        return {
          beforeAppend: (event) => persistTurnEvidence({
            ...options,
            serverLastSequence: event.sequence,
          }),
        }
      }
      return {}
    }
    const emitFailedTerminal = async (sourceError) => {
      const originalError = sourceError
      const artifactIds = normalizeArtifactIds(originalError?.artifactIds ?? checkpointArtifactIds)
      const deliveryArtifactIds = optionalDeliveryArtifactIds(originalError, [])
      const iterations = Math.max(0, Number(originalError?.iterations) || checkpointIterations)
      const failedAt = this.deps.now()
      const verifiedLocalFiles = verifiedLocalFilesAt(failedAt)
      const retainedLocalFiles = retainedLocalFilesAt(failedAt, verifiedLocalFiles)
      let activeError = findEventPersistenceFailure(sourceError) || sourceError

      // The first turn.failed attempt can itself be the durability barrier that
      // discovers an earlier deferred delta failure. That barrier performs no
      // terminal append, so one retry with the persistence failure as the
      // authoritative cause is safe. A direct append failure has unknown
      // outcome and must never be retried blindly.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const failure = normalizeFailure(activeError)
        const partialText = publicIncompleteText(
          originalError?.partialText || originalError?.text || streamedAssistantText,
          failure.message,
        )
        const evidenceOptions = {
          state: 'failed',
          text: partialText,
          artifactIds,
          deliveryArtifactIds,
          iterations,
          error: failure,
          verifiedLocalFiles,
          retainedLocalFiles,
          writtenAt: failedAt,
        }
        try {
          await emitter('turn.failed', {
            code: failure.code,
            message: failure.message,
            error: failure,
            partialText,
            artifactIds,
            ...deliveryArtifactFields(deliveryArtifactIds),
            verifiedLocalFiles,
            retainedLocalFiles,
            iterations,
            ...(latestModelUsage ? { usage: latestModelUsage } : {}),
            ...(turnModelUsage ? { turnModelUsage } : {}),
            ...(latestEstimatedPromptTokens !== null ? { estimatedPromptTokens: latestEstimatedPromptTokens } : {}),
          }, evidenceBoundaryOptions(evidenceOptions))
          if (!atomicTurnBoundary) {
            try {
              await persistTurnEvidence(evidenceOptions)
            } catch {
              // Legacy injected stores retain the event-authoritative behavior.
            }
          }
          await recordCanaryTerminal('failed', failure.code, failedAt, partialText)
          return
        } catch (terminalError) {
          const deferredFailure = findEventPersistenceFailure(terminalError)
          const terminalOutcomeUnknown = String(terminalError?.code || '').trim().toUpperCase()
            === TURN_TERMINAL_PERSISTENCE_FAILURE_CODE
          if (deferredFailure && !terminalOutcomeUnknown && attempt === 0) {
            activeError = deferredFailure
            continue
          }
          throw createTerminalPersistenceFailure(terminalError)
        }
      }
    }
    const emitBlockedRecovery = async (sourceError) => {
      const failure = normalizeFailure(sourceError, { retryable: false })
      const sideEffectUnknown = failure.code === 'SIDE_EFFECT_OUTCOME_UNKNOWN'
        && sourceError?.unsafeToReplay === true
        && sourceError?.requiresUserVerification === true
      const modelRequestUnknown = failure.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
        && sourceError?.unsafeToReplay === true
      const recoveryToolCallId = sideEffectUnknown
        ? normalizeOptionalId(sourceError?.sideEffectExecution?.toolCallId)
        : null
      const recoveryModelRequestId = modelRequestUnknown
        ? normalizeOptionalId(sourceError?.modelRequestId || sourceError?.modelInvocation?.id)
        : null
      const blockedAt = this.deps.now()
      const verifiedLocalFiles = verifiedLocalFilesAt(blockedAt)
      const retainedLocalFiles = retainedLocalFilesAt(blockedAt, verifiedLocalFiles)
      const blockedMessage = sideEffectUnknown
        ? 'Operation outcome is uncertain. Automatic retry was blocked; verify it in Settings > Operation recovery.'
        : modelRequestUnknown
          ? '模型请求在中断前可能已被上游接受。为避免再次请求并产生额外的上游模型供应商费用，系统已阻止自动重试；请在“设置 > 恢复”中核对并裁决该请求。'
        : failure.message
      const blockedRecovery = sideEffectUnknown
        ? {
            recoveryKind: 'side_effect_outcome_unknown',
            requiresUserVerification: true,
            ...(recoveryToolCallId ? { toolCallId: recoveryToolCallId } : {}),
          }
        : modelRequestUnknown
          ? {
              recoveryKind: 'model_request_outcome_unknown',
              requiresUserVerification: true,
              ...(recoveryModelRequestId ? { modelRequestId: recoveryModelRequestId } : {}),
            }
          : null
      const blockedEvidenceOptions = {
        state: 'blocked',
        text: blockedMessage,
        artifactIds: checkpointArtifactIds,
        deliveryArtifactIds: optionalDeliveryArtifactIds(
          { deliveryArtifactIds: checkpointDeliveryArtifactIds },
          [],
        ),
        iterations: checkpointIterations,
        error: { ...failure, message: blockedMessage, retryable: false },
        verifiedLocalFiles,
        retainedLocalFiles,
        blockedRecovery,
        writtenAt: blockedAt,
      }
      const blockedEvent = await emitter('turn.blocked', {
        code: failure.code,
        message: blockedMessage,
        retryable: false,
        manualRetryable: true,
        recoveryStatus: 'dead_letter',
        ...(sideEffectUnknown ? {
          turnId,
          requiresUserVerification: true,
          recoveryKind: 'side_effect_outcome_unknown',
          ...(recoveryToolCallId ? { toolCallId: recoveryToolCallId } : {}),
          recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' },
        } : {}),
        ...(modelRequestUnknown ? {
          turnId,
          requiresUserVerification: true,
          recoveryKind: 'model_request_outcome_unknown',
          ...(recoveryModelRequestId ? { modelRequestId: recoveryModelRequestId } : {}),
          recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' },
        } : {}),
        checkpointSequence: latestCheckpointSequence,
        artifactIds: normalizeArtifactIds(checkpointArtifactIds),
        deliveryArtifactIds: optionalDeliveryArtifactIds(
          { deliveryArtifactIds: checkpointDeliveryArtifactIds },
          [],
        ),
        verifiedLocalFiles,
        retainedLocalFiles,
        iterations: checkpointIterations,
      }, evidenceBoundaryOptions(blockedEvidenceOptions))
      if (!atomicTurnBoundary) {
        try {
          await persistTurnEvidence({
            ...blockedEvidenceOptions,
            serverLastSequence: blockedEvent.sequence,
          })
        } catch {
          // Legacy injected stores retain the event-authoritative behavior.
        }
      }
      await this.deps.writeRecoveryFailure({
        userId,
        sessionId,
        turnId,
        candidateVersion: recoveryCandidateVersion(blockedEvent),
        retryable: false,
        errorCode: failure.code,
        errorMessage: failure.message,
        now: blockedEvent.createdAt,
      })
    }
    let contextWindow
    try {
      contextWindow = this.deps.getContextWindow({
        userId: modelRuntimeEnv ? null : userId,
        modelName: modelName || undefined,
        modelProviderId: modelRuntimeEnv ? undefined : (modelProviderId || undefined),
        env: modelRuntimeEnv || this.deps.env,
      })
    } catch {
      // Endpoint metadata is advisory; model execution remains available if discovery fails.
    }
    try {
      const executionFileAccess = modelToolFileAccessStatus
        ?? this.deps.readFileAccessStatus({ userId })
      const executionRuntimePlugins = this.deps.readRuntimePlugins()
      let executionRuntimePluginStates
      try {
        executionRuntimePluginStates = this.deps.readRuntimePluginStates({
          verifyActiveReleases: true,
        })
      } catch (error) {
        if (restoredCheckpointState
          && String(error?.code || '').trim() === 'PLUGIN_RELEASE_CORRUPT') {
          error.retryable = false
          error.unsafeToReplay = true
        }
        throw error
      }
      const toolImplementations = this.deps.resolveToolImplementationRevisions({
        userId,
        toolSpecs: resolvedToolSpecs,
      })
      const runtimePolicyProvenance = this.deps.readRuntimePolicyProvenance()
      const observedExecutionEnvironment = createTurnExecutionEnvironmentSnapshot({
        modelName,
        modelProviderId,
        modelConfigRevision,
        modelMode: normalizedModelMode,
        approvalMode: currentApprovalMode,
        policy: runtimePolicyProvenance,
        toolsConfig: effectiveToolsConfig,
        toolSpecs: resolvedToolSpecs,
        toolImplementations,
        fileAccess: executionFileAccess,
        runtimePlugins: executionRuntimePlugins,
        runtimePluginStates: executionRuntimePluginStates,
      })
      const effectiveExecutionEnvironment = createTurnExecutionEnvironmentSnapshot({
        modelName,
        modelProviderId,
        modelConfigRevision,
        modelMode: normalizedModelMode,
        approvalMode: effectiveApprovalMode,
        policy: runtimePolicyProvenance,
        toolsConfig: effectiveToolsConfig,
        toolSpecs: resolvedToolSpecs,
        toolImplementations,
        fileAccess: executionFileAccess,
        runtimePlugins: executionRuntimePlugins,
        runtimePluginStates: executionRuntimePluginStates,
      })
      const restoredExecutionEnvironment = restoredCheckpointState?.executionEnvironment
      if (restoredCheckpointState) {
        assertTurnExecutionEnvironmentCompatible(
          restoredExecutionEnvironment,
          observedExecutionEnvironment,
          { directoryAuthorization: resumeContext?.resolution },
        )
        assertTurnExecutionEnvironmentCompatible(
          restoredExecutionEnvironment,
          effectiveExecutionEnvironment,
          { directoryAuthorization: resumeContext?.resolution },
        )
      }
      const runTurnModelRequest = this.deps.modelRequestRunnerFactory({
        runModel: this.deps.runModel,
        prepareAttachments: this.deps.prepareAttachments,
        publishActivity: this.deps.publishActivity,
        emitEvent: emitter,
        userId,
        sessionId,
        turnId,
        modelName,
        modelProviderId,
        modelRuntimeEnv,
        modelMode: normalizedModelMode,
        env: this.deps.env,
        contextWindow,
        firstRequestAttachmentIds: attachmentIdsForFirstModelRequest,
        pendingRecoveryAttempt,
        onRecoveryAttempt: (attempt) => {
          streamedAssistantText = String(attempt?.assistantText || '')
        },
        onPromptTokenEstimate: (value) => {
          latestEstimatedPromptTokens = normalizePromptTokenEstimate(value)
        },
        now: this.deps.now,
      })
      if (typeof runTurnModelRequest !== 'function') {
        throw new TypeError('modelRequestRunnerFactory must return a runModel function')
      }
      const reconcileTurnModelRequest = async (invocation) => {
        const manualResolution = typeof this.deps.readModelRequestResolution === 'function'
          ? await this.deps.readModelRequestResolution({
              userId,
              sessionId,
              turnId,
              invocation,
            })
          : null
        if (manualResolution) return manualResolution
        if (typeof this.deps.reconcileModelRequest !== 'function') return null
        return this.deps.reconcileModelRequest({
          invocation,
          modelName,
          modelProviderId,
          modelConfigRevision,
          env: modelRuntimeEnv || this.deps.env,
        })
      }
      const result = await this.deps.runLoop({
        job: {
          id: turnId,
          userId,
          sessionId,
          modelName: String(modelName || '').trim() || null,
          modelProviderId: normalizeOptionalId(modelProviderId),
          modelConfigRevision: normalizePositiveInteger(modelConfigRevision),
          modelMode: normalizedModelMode,
          agentId: promptContextSnapshot?.effectiveAgentId || promptContext.effectiveAgentId || agentId || null,
          skillIds: effectiveSkillIds,
          skillDefinitions,
          origin: 'chat',
          prompt: content,
          userPrompt: displayContent || content,
          previousUserPrompt,
          title: content.slice(0, 120),
          managedAttachments,
          hasManagedAttachments: managedAttachments.length > 0,
        },
        step: { id: turnId, kind: 'chat' },
        messages,
        contextWindow,
        intentMode: effectiveIntentMode,
        signal,
        toolSpecs: resolvedToolSpecs,
        toolsConfig: effectiveToolsConfig,
        // The loop may progressively remount tools for an execution turn, but
        // its recovery catalog must remain the same user-configured catalog
        // resolved above. Never let it fall back to the global server catalog.
        fallbackToolSpecs: resolvedToolSpecs,
        toolResolutionDecision,
        skillId: activeSkillId,
        executeTool: chatOnlyMode
          ? async () => { throw createChatOnlyToolExecutionError() }
          : this.deps.executeTool,
        approvalOrigin: 'chat',
        approvalSessionId: sessionId,
        approvalMode: effectiveApprovalMode,
        claimSteering: steeringOwnerId
          ? async () => this.deps.claimSteering({
              ...steeringScope,
              now: this.deps.now(),
            })
          : null,
        acknowledgeSteering: steeringOwnerId
          ? async (leaseId) => this.deps.acknowledgeSteering({
              ...steeringScope,
              leaseId,
              now: this.deps.now(),
            })
          : null,
        releaseSteering: steeringOwnerId
          ? async (leaseId) => this.deps.releaseSteering({
              ...steeringScope,
              leaseId,
              now: this.deps.now(),
            })
          : null,
        beforeFinalCompletion: steeringOwnerId
          ? async () => {
              const decision = await this.deps.runtimeCore.lease.closeSteeringInbox({ userId, sessionId, turnId })
              if (!decision?.closed && decision?.reason !== 'pending') {
                throw abortError('TURN_LEASE_LOST', 'Turn execution lease was lost before completion')
              }
              return decision
            }
          : null,
        loadCheckpoint: async () => restoredCheckpointState || null,
        reconcileModelRequest: reconcileTurnModelRequest,
        saveCheckpoint: async (state) => {
          if (!this.deps.supportsAtomicCheckpointState) {
            const error = new TurnEngineError(
              ATOMIC_CHECKPOINT_UNSUPPORTED_CODE,
              'The configured turn event adapter does not support atomic checkpoint state commits.',
              503,
            )
            error.retryable = false
            error.unsafeToReplay = true
            throw error
          }
          checkpointMessages = checkpointMessagesForTurn(state, {
            content,
            fallback: checkpointMessages,
          })
          const checkpointState = {
            ...state,
            approvalMode: effectiveApprovalMode,
            modelMode: normalizedModelMode,
            executionEnvironment: effectiveExecutionEnvironment,
            promptContextSnapshot,
            turnMessages: checkpointMessages,
            ...(latestModelUsage ? { latestModelUsage } : {}),
            ...(turnModelUsage ? { turnModelUsage } : {}),
            ...(latestEstimatedPromptTokens !== null ? { latestEstimatedPromptTokens } : {}),
          }
          const nextCheckpointArtifactIds = normalizeArtifactIds(
            checkpointState?.artifactIds ?? checkpointArtifactIds,
          )
          const artifactCollectionChanged = !sameArtifactIds(checkpointArtifactIds, nextCheckpointArtifactIds)
          checkpointArtifactIds = nextCheckpointArtifactIds
          checkpointDeliveryArtifactIds = optionalDeliveryArtifactIds(
            checkpointState,
            artifactCollectionChanged ? [] : checkpointDeliveryArtifactIds,
          )
          checkpointIterations = Math.max(0, Number(checkpointState?.iterations) || checkpointIterations)
          checkpointRecovery = checkpointState?.recovery || checkpointRecovery
          const checkpointEvent = await emitter('turn.checkpoint', {
            storage: 'turn_checkpoints',
            checkpointVersion: 1,
            iterations: checkpointIterations,
            toolCallCount: Array.isArray(checkpointState?.toolCalls) ? checkpointState.toolCalls.length : 0,
          }, {
            checkpointState,
            commitEvent: typeof this.deps.commitTurnCheckpoint === 'function'
                ? ({ event, checkpointState: durableState }) => this.deps.commitTurnCheckpoint({
                    userId,
                    event,
                    checkpointState: durableState,
                    executionLease,
                  })
              : null,
          })
          const saved = await this.deps.runtimeCore.checkpoint.load({ userId, sessionId, turnId })
          if (saved?.eventSequence !== checkpointEvent.sequence) {
            const error = new TurnEngineError(
              ATOMIC_CHECKPOINT_COMMIT_MISMATCH_CODE,
              'The turn event adapter acknowledged a checkpoint event without atomically committing its state.',
              503,
            )
            error.retryable = false
            error.unsafeToReplay = true
            error.eventSequence = checkpointEvent.sequence
            throw error
          }
          if (!saved?.state) throw new Error('Failed to persist turn checkpoint')
          latestCheckpointSequence = checkpointEvent.sequence
          return true
        },
        runModel: runTurnModelRequest,
        onModelPhase: async ({ phase, iteration, usage, modelName: activeModel, error }) => {
          const normalizedUsage = phase === 'completed' ? normalizeModelUsage(usage) : null
          if (normalizedUsage) {
            latestModelUsage = normalizedUsage
            turnModelUsage = addModelUsage(turnModelUsage, normalizedUsage)
          }
          await emitter('model.phase', {
            phase,
            iteration,
            usage: normalizedUsage || usage,
            modelName: activeModel,
            error,
          })
        },
        onModelDelta: async ({ text: delta, iteration, modelName: activeModel }) => {
          streamedAssistantText += String(delta || '')
          await emitter('assistant.delta', { text: delta, iteration, modelName: activeModel })
        },
        onReasoningDelta: async ({ text: delta, iteration, modelName: activeModel }) => {
          await emitter('reasoning.delta', { text: delta, iteration, modelName: activeModel })
        },
        onProgress: async ({ completed, total, iteration, filesChanged, additions, deletions, phase } = {}) => {
          await emitter('turn.progress', {
            ...(completed !== undefined ? { completed } : {}),
            ...(total !== undefined ? { total } : {}),
            ...(iteration !== undefined ? { iteration } : {}),
            ...(filesChanged !== undefined ? { filesChanged } : {}),
            ...(additions !== undefined ? { additions } : {}),
            ...(deletions !== undefined ? { deletions } : {}),
            ...(phase !== undefined ? { phase } : {}),
          })
        },
        onToolCall: async (call) => emitter('tool.call', {
          toolCallId: call.id, name: call.name, args: call.args,
        }),
        onToolStarted: async (call) => emitter('tool.started', {
          toolCallId: call.id, name: call.name, args: call.args, outputReplay: 'live_only',
        }),
        onToolCompleted: async (outcome) => {
          const failure = outcome.result?.ok === false ? {
            code: String(outcome.result.code || 'tool_execution_failed'),
            message: String(outcome.result.error || 'Tool execution failed.'),
            retryable: outcome.result.retryable === true,
            ...(Number.isInteger(outcome.result.status) ? { status: outcome.result.status } : {}),
            ...(outcome.result.hint ? { hint: String(outcome.result.hint) } : {}),
            ...(Number.isInteger(outcome.result.attempts) ? { attempts: outcome.result.attempts } : {}),
          } : null
          return emitter('tool.completed', {
            toolCallId: outcome.call.id, name: outcome.call.name,
            args: outcome.executionArgs ?? outcome.call.args,
            result: outcome.result,
            error: failure,
            artifactId: outcome.artifactId || null,
            artifacts: Array.isArray(outcome.artifacts) ? outcome.artifacts : [],
          })
        },
        onApprovalPending: async (approval) => emitter('approval.required', {
          approvalId: approval.id, toolName: approval.toolName, args: approval.args,
          risk: approval.risk, metadataSource: approval.metadataSource,
          reason: approval.reason, expiresAt: approval.expiresAt,
        }),
        onApprovalResolved: async (decision) => emitter('approval.resolved', {
          approvalId: decision.approvalId || null,
          proceed: !!decision.proceed,
          edited: !!decision.edited,
          args: decision.args ?? null,
          reason: decision.reason || null,
        }),
      })
      if (signal.aborted) {
        if (lostTurnLease(signal)) return
        const cancelledAt = this.deps.now()
        const verifiedLocalFiles = verifiedLocalFilesAt(cancelledAt)
        const retainedLocalFiles = retainedLocalFilesAt(cancelledAt, verifiedLocalFiles)
        const artifactIds = normalizeArtifactIds(checkpointArtifactIds)
        const evidenceOptions = {
          state: 'cancelled',
          text: streamedAssistantText || 'Cancelled by user',
          artifactIds,
          deliveryArtifactIds: [],
          iterations: checkpointIterations,
          verifiedLocalFiles,
          retainedLocalFiles,
          writtenAt: cancelledAt,
        }
        await emitter('turn.cancelled', {
          reason: 'Cancelled by user',
          artifactIds,
          deliveryArtifactIds: [],
          verifiedLocalFiles,
          retainedLocalFiles,
          iterations: checkpointIterations,
          ...(latestModelUsage ? { usage: latestModelUsage } : {}),
          ...(turnModelUsage ? { turnModelUsage } : {}),
          ...(latestEstimatedPromptTokens !== null ? { estimatedPromptTokens: latestEstimatedPromptTokens } : {}),
        }, evidenceBoundaryOptions(evidenceOptions))
        if (!atomicTurnBoundary) {
          try {
            await persistTurnEvidence(evidenceOptions)
          } catch {
            // Legacy injected stores retain the event-authoritative behavior.
          }
        }
        await recordCanaryTerminal(
          'cancelled',
          null,
          cancelledAt,
          streamedAssistantText || 'Cancelled by user',
        )
        return
      }
      if (result?.interrupted) {
        const artifactIds = normalizeArtifactIds(result.artifactIds ?? checkpointArtifactIds)
        const deliveryArtifactIds = []
        const iterations = Math.max(0, Number(result.iterations) || checkpointIterations)
        const partialText = publicIncompleteText(
          result.text || streamedAssistantText,
          PUBLIC_TURN_INTERRUPTED,
        )
        const interruptedAt = this.deps.now()
        const verifiedLocalFiles = verifiedLocalFilesAt(interruptedAt)
        const retainedLocalFiles = retainedLocalFilesAt(interruptedAt, verifiedLocalFiles)
        const failure = normalizeFailure({
          code: result.code,
          message: result.reason,
          retryable: true,
        }, { code: 'MODEL_CALL_INTERRUPTED', retryable: true })
        const evidenceOptions = {
          state: 'interrupted',
          text: partialText,
          artifactIds,
          deliveryArtifactIds,
          iterations,
          error: failure,
          verifiedLocalFiles,
          retainedLocalFiles,
          writtenAt: interruptedAt,
        }
        await emitter('turn.interrupted', {
          code: String(result.code || 'MODEL_CALL_INTERRUPTED'),
          message: failure.message,
          retryable: true,
          text: partialText,
          artifactIds,
          ...deliveryArtifactFields(deliveryArtifactIds),
          verifiedLocalFiles,
          retainedLocalFiles,
          iterations,
          ...(latestModelUsage ? { usage: latestModelUsage } : {}),
          ...(turnModelUsage ? { turnModelUsage } : {}),
          ...(latestEstimatedPromptTokens !== null ? { estimatedPromptTokens: latestEstimatedPromptTokens } : {}),
        }, evidenceBoundaryOptions(evidenceOptions, { legacyBeforeAppend: true }))
        return
      }
      if (result?.incomplete) {
        const partialText = publicIncompleteText(result.text || streamedAssistantText)
        const resultCode = String(result.code || '').trim()
        const resultRetryable = typeof result.retryable === 'boolean'
          ? result.retryable
          : resultCode !== 'REASONING_RUNAWAY'
        // A user-triggered failed retry gets one real checkpoint continuation.
        // If that continuation still cannot finish, another identical retry is
        // unlikely to make progress and previously created an infinite button
        // loop. Keep the evidence, but close this Turn as non-retryable.
        const retryable = failedRetryActive ? false : resultRetryable
        const nonRetryableReason = String(result.reason || '').trim()
        const failure = normalizeFailure({
          code: resultCode || 'TURN_INCOMPLETE',
          // Keep the wrap-up in partialText and the machine reason in the
          // hint. Reusing the wrap-up as the error message would make clients
          // append the same useful result a second time as an error banner.
          message: !retryable && nonRetryableReason
            ? nonRetryableReason
            : PUBLIC_TURN_INCOMPLETE,
          retryable,
          ...(failedRetryActive && resultRetryable
            ? { hint: '本任务已执行一次断点续写但仍未完成。请查看具体阻塞，调整模型、权限或工具条件后发送新消息。' }
            : result.hint ? { hint: String(result.hint) } : retryable
            ? { hint: '请重试本任务；系统会继续处理尚未完成的步骤。' }
            : {}),
        }, { retryable })
        const artifactIds = normalizeArtifactIds(result.artifactIds ?? checkpointArtifactIds)
        // An incomplete loop may still return an explicit, already-validated
        // partial selection. Never revive an implicit checkpoint selection:
        // only the terminal result is authoritative for partial delivery.
        const deliveryArtifactIds = optionalDeliveryArtifactIds(result, [])
        const iterations = Math.max(0, Number(result.iterations) || checkpointIterations)
        const failedAt = this.deps.now()
        const verifiedLocalFiles = verifiedLocalFilesAt(failedAt)
        const retainedLocalFiles = retainedLocalFilesAt(failedAt, verifiedLocalFiles)
        const evidenceOptions = {
          state: 'failed',
          text: partialText,
          artifactIds,
          deliveryArtifactIds,
          iterations,
          error: failure,
          verifiedLocalFiles,
          retainedLocalFiles,
          writtenAt: failedAt,
        }
        if (!atomicTurnBoundary) await persistTurnEvidence(evidenceOptions)
        await emitter('turn.failed', {
          code: failure.code,
          message: failure.message,
          error: failure,
          partialText,
          artifactIds,
          ...deliveryArtifactFields(deliveryArtifactIds),
          verifiedLocalFiles,
          retainedLocalFiles,
          iterations,
          ...(latestModelUsage ? { usage: latestModelUsage } : {}),
          ...(turnModelUsage ? { turnModelUsage } : {}),
          ...(latestEstimatedPromptTokens !== null ? { estimatedPromptTokens: latestEstimatedPromptTokens } : {}),
        }, evidenceBoundaryOptions(evidenceOptions))
        await recordCanaryTerminal('failed', failure.code, failedAt, partialText)
        return
      }
      if (result?.paused) {
        const text = finalClarificationText(result)
        const clarification = isRecord(result.clarification) || typeof result.clarification === 'string'
          ? result.clarification
          : { question: text, blocker_kind: 'missing_info' }
        const artifactIds = normalizeArtifactIds(result.artifactIds ?? checkpointArtifactIds)
        const deliveryArtifactIds = []
        const iterations = Math.max(0, Number(result.iterations) || checkpointIterations)
        const pausedAt = this.deps.now()
        const verifiedLocalFiles = verifiedLocalFilesAt(pausedAt)
        const retainedLocalFiles = retainedLocalFilesAt(pausedAt, verifiedLocalFiles)
        const createPausedMessage = (pausedEvent) => ({
          id: `${turnId}:assistant`,
          userId,
          sessionId,
          role: 'assistant',
          content: text,
          modelContext: {
            ...buildAssistantModelContext({
              turnId,
              checkpointMessages,
              baselineToolCallIds,
              userId,
              verifiedLocalFiles,
              retainedLocalFiles,
              artifactIds,
              deliveryArtifactIds,
              iterations,
              paused: true,
              pluginPromptBlockIds: promptContextSnapshot?.pluginPromptBlockIds,
              compactionArchiveId: result?.recovery?.archiveId || null,
              compactionRecovery: result?.recovery || checkpointRecovery,
              usage: latestModelUsage,
              turnModelUsage,
              estimatedPromptTokens: latestEstimatedPromptTokens,
              turnStartedAt: effectiveTurnStartedAt,
              turnCompletedAt: pausedAt,
            }),
            clarification,
            pausedSequence: pausedEvent.sequence,
          },
          createdAt: pausedAt,
          updatedAt: pausedAt,
        })
        await emitter('turn.paused', {
          text,
          clarification,
          artifactIds,
          ...deliveryArtifactFields(deliveryArtifactIds),
          verifiedLocalFiles,
          retainedLocalFiles,
          iterations,
          ...(latestModelUsage ? { usage: latestModelUsage } : {}),
          ...(turnModelUsage ? { turnModelUsage } : {}),
          ...(latestEstimatedPromptTokens !== null ? { estimatedPromptTokens: latestEstimatedPromptTokens } : {}),
        }, atomicTurnBoundary ? {
          commitEvent: ({ event }) => commitBoundaryEvent({
            event,
            message: createPausedMessage(event),
          }),
        } : {
          beforeAppend: async (event) => this.deps.writeMessage(createPausedMessage(event)),
        })
        return
      }
      const text = String(result?.text || '(任务已结束，但模型没有返回文本。)')
      const artifactIds = normalizeArtifactIds(result?.artifactIds ?? checkpointArtifactIds)
      const deliveryArtifactIds = optionalDeliveryArtifactIds(result, checkpointDeliveryArtifactIds)
      const completedAt = this.deps.now()
      const verifiedLocalFiles = verifiedLocalFilesAt(completedAt)
      const retainedLocalFiles = retainedLocalFilesAt(completedAt, verifiedLocalFiles)
      const completedMessage = {
        id: `${turnId}:assistant`, userId, sessionId, role: 'assistant', content: text,
        modelContext: buildAssistantModelContext({
          turnId,
          checkpointMessages,
          baselineToolCallIds,
          userId,
          verifiedLocalFiles,
          retainedLocalFiles,
          artifactIds,
          deliveryArtifactIds,
          iterations: result?.iterations || 0,
          pluginPromptBlockIds: promptContextSnapshot?.pluginPromptBlockIds,
          compactionArchiveId: result?.recovery?.archiveId || null,
          compactionRecovery: result?.recovery || checkpointRecovery,
          usage: latestModelUsage,
          turnModelUsage,
          estimatedPromptTokens: latestEstimatedPromptTokens,
          turnStartedAt: effectiveTurnStartedAt,
          turnCompletedAt: completedAt,
        }),
        createdAt: completedAt, updatedAt: completedAt,
      }
      await emitter('turn.completed', {
        text,
        artifactIds,
        ...deliveryArtifactFields(deliveryArtifactIds),
        verifiedLocalFiles,
        retainedLocalFiles,
        iterations: result?.iterations || 0,
        ...(latestModelUsage ? { usage: latestModelUsage } : {}),
        ...(turnModelUsage ? { turnModelUsage } : {}),
        ...(latestEstimatedPromptTokens !== null ? { estimatedPromptTokens: latestEstimatedPromptTokens } : {}),
      }, {
        commitEvent: atomicTurnBoundary
          ? ({ event }) => commitBoundaryEvent({ event, message: completedMessage })
          : null,
      })
      if (!atomicTurnBoundary) {
        try {
          await this.deps.writeMessage(completedMessage)
        } catch {
          // Legacy injected stores retain the event-authoritative behavior.
        }
      }
      await recordCanaryTerminal('completed', null, completedAt, text)
      // Best-effort async notification to external subscribers.
      void this.deps.dispatchHooks?.({
        userId,
        event: 'notification',
        tool: null,
        args: {
          text: String(text || '').slice(0, 4_000),
          artifactIds,
          ...deliveryArtifactFields(deliveryArtifactIds),
          iterations: result?.iterations || 0,
        },
        sessionId,
      }).catch(() => { /* notification hook is best-effort */ })
      try {
        this.deps.scheduleMemoryExtraction({
          userId,
          sessionId,
          agentId: promptContext.effectiveAgentId || agentId || null,
          messages: historyMessages,
          assistantText: text,
          callModel: ({ messages: memoryMessages }) => this.deps.runMemoryModel({
            messages: memoryMessages,
            userId,
          }),
        })
      } catch {
        // Automatic memory extraction is best-effort and must not change turn completion.
      }
    } catch (error) {
      if (lostTurnLease(signal, error)) return
      if (isManualRecoveryBlock(error)) {
        await emitBlockedRecovery(error)
        return
      }
      if (String(error?.code || '').trim().toUpperCase() === TURN_TERMINAL_PERSISTENCE_FAILURE_CODE) {
        throw error
      }
      const deferredPersistenceFailure = findEventPersistenceFailure(error)
      if (deferredPersistenceFailure) {
        await emitFailedTerminal(deferredPersistenceFailure)
        return
      }
      if (isExplicitTurnCancellation(signal, error)) {
        const cancelledAt = this.deps.now()
        const verifiedLocalFiles = verifiedLocalFilesAt(cancelledAt)
        const retainedLocalFiles = retainedLocalFilesAt(cancelledAt, verifiedLocalFiles)
        const artifactIds = normalizeArtifactIds(checkpointArtifactIds)
        const evidenceOptions = {
          state: 'cancelled',
          text: streamedAssistantText || error?.message || 'Cancelled by user',
          artifactIds,
          deliveryArtifactIds: [],
          iterations: checkpointIterations,
          verifiedLocalFiles,
          retainedLocalFiles,
          writtenAt: cancelledAt,
        }
        try {
          await emitter('turn.cancelled', {
            reason: error?.message || 'Cancelled by user',
            artifactIds,
            deliveryArtifactIds: [],
            verifiedLocalFiles,
            retainedLocalFiles,
            iterations: checkpointIterations,
            ...(latestModelUsage ? { usage: latestModelUsage } : {}),
            ...(turnModelUsage ? { turnModelUsage } : {}),
            ...(latestEstimatedPromptTokens !== null ? { estimatedPromptTokens: latestEstimatedPromptTokens } : {}),
          }, evidenceBoundaryOptions(evidenceOptions))
        } catch (terminalError) {
          const deferredFailure = findEventPersistenceFailure(terminalError)
          if (!deferredFailure) throw terminalError
          await emitFailedTerminal(deferredFailure)
          return
        }
        if (!atomicTurnBoundary) {
          try {
            await persistTurnEvidence(evidenceOptions)
          } catch {
            // Legacy injected stores retain the event-authoritative behavior.
          }
        }
        await recordCanaryTerminal('cancelled', null, cancelledAt, evidenceOptions.text)
        return
      }
      await emitFailedTerminal(error)
    }
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
