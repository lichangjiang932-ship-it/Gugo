import { observeLoopEvent } from './eventIsolation.js'
import {
  appendModelProviderAttempt,
  createModelInvocation,
  fingerprintModelRequest,
  reconcileRecoveredModelInvocation,
  snapshotModelResponse,
} from './modelInvocationCheckpoint.js'
import { installArtifactSteeringContract } from './runtime-initializeArtifactSteering.js'
import { installTerminalCompletion } from './runtime-initializeTerminalCompletion.js'
import { discardContinuedAnswer } from './outputContinuation.js'

export function resolveExecutionBudgetOptions(job, restoredBudget) {
  if (!restoredBudget || typeof restoredBudget !== 'object') return restoredBudget
  const executionBudget = { ...restoredBudget }
  delete executionBudget.maxCostUsd
  return executionBudget
}

function installSteeringMessageRuntime(s) {
  const { LIVE_STEERING_GUARD_MARKER, hasMutationExecutionIntent,
    requestedArtifactOutputDirective } = s.d
  s.appendSteeringMessages = (messages = []) => {
    if (!messages.length) return 0
    discardContinuedAnswer(s)
    s.repeatCallGuard.reset()
    s.loopGuard.resetRepetition?.()
    s.pendingRepeatCallReminder = null
    if (!s.hasRuntimeMarker(LIVE_STEERING_GUARD_MARKER)) {
      s.convo.push({
        role: 'system',
        content: `${LIVE_STEERING_GUARD_MARKER} The user sent steering updates while this task was running. Apply them now; newer user direction takes precedence.`,
      })
    }
    for (const steering of messages) {
      const id = String(steering?.id || '').trim()
      if (id) s.appliedSteeringIds.add(id)
      s.convo.push({ role: 'user', content: steering.content })
      if (requestedArtifactOutputDirective(steering.content).hasDirective) {
        s.activeArtifactOutputPrompt = String(steering.content || '').trim()
      }
      s.refreshArtifactContractFromSteering(steering.content)
      if (hasMutationExecutionIntent(String(steering?.content || ''))) {
        s.mutationSteeringPending = true
        s.verifiedRecoveredMutationObserved = false
        s.recoveredMutationVerificationPending = false
      }
    }
    return messages.length
  }
}

function initializeExecutionBudget(s) {
  const { attachJobBudget, createJobBudget, getJobBudget } = s.d
  s.restoredBudget = s.restoredState?.budget && typeof s.restoredState.budget === 'object'
    ? {
        maxTotalCalls: s.restoredState.budget.maxTotalCalls,
        maxWallMs: s.restoredState.budget.maxWallMs,
        maxModelCalls: s.restoredState.budget.maxModelCalls,
        maxModelTokens: s.restoredState.budget.maxModelTokens,
        maxCostUsd: s.restoredState.budget.maxCostUsd,
        initialUsed: s.restoredState.budget.used,
        initialElapsedMs: s.restoredState.budget.elapsed,
        initialModelMs: s.restoredState.budget.modelMs,
        initialModelCalls: s.restoredState.budget.modelCalls,
        initialModelTokens: s.restoredState.budget.modelTokens,
        initialCostUsd: s.restoredState.budget.costUsd,
        initialCostEvidenceComplete: s.restoredState.budget.costEvidenceComplete,
      }
    : undefined
  const usesSharedJobBudget = s.job && s.job.origin !== 'chat'
  const options = resolveExecutionBudgetOptions(s.job, s.restoredBudget)
  s.budget = s.runtimeBudget || (usesSharedJobBudget
    ? (getJobBudget(s.job) || attachJobBudget(s.job, options))
    : createJobBudget(options))
}

async function prepareTrackedInvocation(s, context, preparedRequest, attempt) {
  const { recordRecoveredModelResult } = s.d
  context.assertActive()
  const requestFingerprint = fingerprintModelRequest(preparedRequest, {
    jobId: s.job?.id,
    stepId: s.step?.id,
    iteration: s.iter,
    modelName: s.job?.modelName,
    modelProviderId: s.job?.modelProviderId,
    modelConfigRevision: s.job?.modelConfigRevision,
    attachmentIds: Array.isArray(s.job?.managedAttachments)
      ? s.job.managedAttachments.map((attachment) => attachment?.id)
      : [],
  })
  let recoveredNextAttempt = null
  if (s.restoredModelInvocation) {
    const resolution = await reconcileRecoveredModelInvocation(s.restoredModelInvocation, {
      fingerprint: requestFingerprint,
      iteration: s.iter,
      modelName: s.job?.modelName,
      modelProviderId: s.job?.modelProviderId,
      modelConfigRevision: s.job?.modelConfigRevision,
      reconcileRequest: s.reconcileModelRequest,
    })
    context.assertActive()
    s.restoredModelInvocation = null
    s.modelInvocation = resolution.invocation || null
    let recoveredBudgetError = null
    if (resolution.kind === 'replay' && resolution.invocation?.usageApplied === false) {
      try { recordRecoveredModelResult(s.budget, resolution.response, context.budgetOptions) }
      catch (error) { recoveredBudgetError = error }
      s.modelInvocation = { ...resolution.invocation, usageApplied: true }
    }
    if (resolution.checkpointRequired) {
      context.assertActive()
      await s.checkpointBarrier.flush({
        meta: {
          boundary: 'model-request-reconciled',
          iteration: s.iter,
          attempt: resolution.invocation.attempt,
          modelRequestId: resolution.invocation.id,
          outcome: resolution.invocation.status,
        },
      })
      context.assertActive()
    }
    if (resolution.kind === 'replay') {
      context.preparedInvocation = {
        cached: true,
        ...resolution,
        ...(recoveredBudgetError ? { budgetError: recoveredBudgetError } : {}),
      }
      return { ...preparedRequest, modelRequestId: resolution.invocation.id }
    }
    recoveredNextAttempt = resolution.nextAttempt || null
  }
  context.assertActive()
  const invocation = createModelInvocation({
    fingerprint: requestFingerprint,
    jobId: s.job?.id,
    stepId: s.step?.id,
    iteration: s.iter,
    attempt: recoveredNextAttempt || attempt,
    modelName: s.job?.modelName,
    modelProviderId: s.job?.modelProviderId,
    modelConfigRevision: s.job?.modelConfigRevision,
  })
  s.modelInvocation = invocation
  context.preparedInvocation = { cached: false, invocation }
  context.assertActive()
  await s.checkpointBarrier.beforeSideEffect({
    meta: {
      boundary: 'model-request',
      iteration: s.iter,
      attempt,
      modelRequestId: invocation.id,
    },
  })
  context.assertActive()
  return {
    ...preparedRequest,
    modelRequestId: invocation.id,
    onProviderAttempt: async (providerAttempt) => {
      context.assertActive()
      if (s.modelInvocation?.id !== invocation.id || s.modelInvocation?.status !== 'in_flight') {
        const error = new Error('physical Provider attempt lost its model invocation fence')
        error.code = 'MODEL_PROVIDER_ATTEMPT_CONFLICT'
        error.retryable = false
        error.unsafeToReplay = true
        throw error
      }
      s.modelInvocation = appendModelProviderAttempt(s.modelInvocation, providerAttempt)
      context.assertActive()
      await s.checkpointBarrier.beforeSideEffect({
        meta: {
          boundary: 'model-provider-attempt',
          iteration: s.iter,
          attempt: invocation.attempt,
          modelRequestId: invocation.id,
          physicalAttempt: providerAttempt.sequence,
          providerAttempt: providerAttempt.providerAttempt,
          failoverIndex: providerAttempt.failoverIndex,
          providerId: providerAttempt.providerId,
          modelName: providerAttempt.modelName,
        },
      })
      context.assertActive()
    },
  }
}

async function executeTrackedInvocation(s, context, preparedRequest) {
  const { runWithModelBudget } = s.d
  context.assertActive()
  if (context.preparedInvocation?.cached) {
    if (context.preparedInvocation.budgetError) throw context.preparedInvocation.budgetError
    return context.preparedInvocation.response
  }
  const invocation = context.preparedInvocation?.invocation
  try {
    const response = await runWithModelBudget(
      s.budget,
      () => {
        context.assertActive()
        return s.runModel(preparedRequest)
      },
      context.budgetOptions,
    )
    context.assertActive()
    const checkpointed = s.modelInvocation?.id === invocation.id ? s.modelInvocation : invocation
    s.modelInvocation = {
      ...checkpointed,
      status: 'completed',
      response: snapshotModelResponse(response),
      usageApplied: true,
    }
    context.assertActive()
    await s.checkpointBarrier.flush({
      meta: {
        boundary: 'model-response', iteration: s.iter,
        attempt: invocation.attempt, modelRequestId: invocation.id,
      },
    })
    context.assertActive()
    return response
  } catch (error) {
    if (context.requestFenceFailures.has(error)) throw error
    context.assertActive()
    const checkpointed = s.modelInvocation?.id === invocation.id ? s.modelInvocation : invocation
    if (error?.partialModelResult) {
      s.modelInvocation = {
        ...checkpointed,
        status: 'completed',
        response: snapshotModelResponse(error.partialModelResult),
        usageApplied: true,
      }
      context.assertActive()
      await s.checkpointBarrier.flush({
        meta: {
          boundary: 'model-response', iteration: s.iter,
          attempt: invocation.attempt, modelRequestId: invocation.id,
        },
      })
      context.assertActive()
      throw error
    }
    if (error?.code === 'CHECKPOINT_FLUSH_FAILED') {
      error.unsafeToReplay = true
      throw error
    }
    if (error?.modelRequestOutcome === 'not_sent') {
      s.modelInvocation = { ...checkpointed, status: 'not_sent' }
      context.assertActive()
      await s.checkpointBarrier.flush({
        meta: {
          boundary: 'model-request-not-sent', iteration: s.iter,
          attempt: invocation.attempt, modelRequestId: invocation.id,
        },
      })
      context.assertActive()
      throw error
    }
    if (error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN' || error?.unsafeToReplay === true) throw error
    context.assertActive()
    s.modelInvocation = {
      ...checkpointed,
      status: 'failed',
      errorCode: String(error?.code || 'MODEL_CALL_FAILED'),
    }
    context.assertActive()
    await s.checkpointBarrier.flush({
      meta: {
        boundary: 'model-request-failed', iteration: s.iter,
        attempt: invocation.attempt, modelRequestId: invocation.id,
      },
    })
    context.assertActive()
    throw error
  }
}

async function invokeModelWithCompatibilityFallback(s, context, modelRequest) {
  const { isForcedToolChoiceCompatibilityError, runModelStep } = s.d
  const invoke = (requestPayload) => runModelStep({
    request: requestPayload,
    loopEvents: s.activeLoopEvents,
    context: s.loopEventContext({ phase: 'model-request' }),
    beforeRequest: ({ request, attempt }) => prepareTrackedInvocation(s, context, request, attempt),
    runModel: (request) => executeTrackedInvocation(s, context, request),
  })
  await context.heartbeat.beginRequest()
  try {
    const response = await invoke(modelRequest)
    context.assertActive()
    return response
  } catch (error) {
    if (context.requestFenceFailures.has(error)) throw error
    context.assertActive()
    const forcedChoice = modelRequest?.toolChoice
    if (context.forcedFallbackUsed
      || !forcedChoice
      || typeof forcedChoice !== 'object'
      || !isForcedToolChoiceCompatibilityError(error)) throw error
    context.forcedFallbackUsed = true
    const compatibleRequest = { ...modelRequest }
    delete compatibleRequest.toolChoice
    context.assertActive()
    await context.heartbeat.beginRequest()
    context.assertActive()
    const response = await invoke(compatibleRequest)
    context.assertActive()
    return response
  }
}

async function callTrackedModel(s, options) {
  const {
    callModelWithContextRecovery,
    createModelPhaseHeartbeat,
    isContextLengthError,
    stripEphemeralToolMediaMessages,
  } = s.d
  const {
    messages,
    tools = [],
    toolChoice,
    consumeBudget,
    allowOverBudget = false,
    onTextDelta,
    onReasoningDelta,
    requestSignal = s.signal,
    assertRequestActive = null,
  } = options
  if (assertRequestActive !== null && typeof assertRequestActive !== 'function') {
    throw new TypeError('assertRequestActive must be a function or null')
  }
  const requestFenceFailures = new Set()
  const assertActive = () => {
    if (!assertRequestActive) return
    try {
      const result = assertRequestActive()
      if (result && typeof result.then === 'function') {
        throw new TypeError('assertRequestActive must be synchronous')
      }
    } catch (error) {
      requestFenceFailures.add(error)
      throw error
    }
  }
  assertActive()
  if (typeof s.onModelPhase === 'function') {
    await s.onModelPhase({ phase: 'started', iteration: s.iter })
    assertActive()
  }
  const heartbeat = createModelPhaseHeartbeat({
    onPhase: s.onModelPhase,
    iteration: s.iter,
    intervalMs: s.modelHeartbeatIntervalMs,
  })
  const ephemeralMessages = s.pendingEphemeralToolMessages.splice(0)
  const context = {
    assertActive,
    requestFenceFailures,
    heartbeat,
    budgetOptions: { allowOverBudget },
    preparedInvocation: null,
    forcedFallbackUsed: false,
  }
  try {
    assertActive()
    const request = await callModelWithContextRecovery({
      messages,
      ephemeralMessages,
      tools,
      callModel: (modelRequest) => invokeModelWithCompatibilityFallback(s, context, modelRequest),
      isContextLengthError,
      contextWindow: s.contextWindow,
      locale: s.job?.locale,
      semanticSummary: s.semanticSummary,
      signal: requestSignal,
      userId: s.job?.userId || null,
      sessionId: s.recoverySessionId,
      compactionArchivePort: s.compactionArchivePort,
      ...(typeof consumeBudget === 'function' ? { consumeBudget } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      onTextDelta: async (text, metadata = {}) => {
        if (text) await heartbeat.recordDelta()
        if (typeof onTextDelta === 'function') await onTextDelta(text, metadata)
      },
      onReasoningDelta: async (text, metadata = {}) => {
        if (text) await heartbeat.recordDelta()
        if (typeof onReasoningDelta === 'function') await onReasoningDelta(text, metadata)
      },
    })
    assertActive()
    if (request.recovery?.compacted === true) {
      await observeLoopEvent({
        loopEvents: s.activeLoopEvents,
        event: 'compaction',
        value: { recovery: request.recovery, messages: request.messages },
        context: s.loopEventContext({ phase: 'context-compaction' }),
      })
      assertActive()
    }
    return { ...request, messages: stripEphemeralToolMediaMessages(request.messages) }
  } finally {
    await heartbeat.stop()
  }
}

function installConvergenceRuntime(s) {
  const { MAX_INSTALL_ATTEMPT_SIGNATURES, createSubagentApprovalContext,
    createToolLoopGuard, installAttemptSignature, isProbeLikeCall } = s.d
  s.subagentApprovalContext = s.approvalContext || createSubagentApprovalContext()
  s.loopGuard = createToolLoopGuard({
    maxRepeatedCalls: 2,
    maxConsecutiveErrors: 20,
    maxSameToolFailures: 20,
    initialState: s.restoredState?.loopGuard,
  })
  s.rememberInstallAttempt = (signature) => {
    if (!signature) return
    s.executionConvergence.installAttempts = s.executionConvergence.installAttempts
      .filter((item) => item !== signature)
    s.executionConvergence.installAttempts.push(signature)
    s.executionConvergence.installAttempts = s.executionConvergence.installAttempts
      .slice(-MAX_INSTALL_ATTEMPT_SIGNATURES)
  }
  s.convergenceBlockFor = (call) => {
    if (!s.executionConvergenceEnabled || !s.executionConvergence.interventionActive) return null
    if (isProbeLikeCall(call)) {
      return {
        ok: false,
        code: 'execution_convergence_probe_blocked',
        error: 'The call was blocked because this execution task already spent several rounds on environment or inspection probes without producing the requested output.',
        retryable: false,
        blockedKind: 'probe',
        hint: 'Stop creating or running inspection scripts. Execute the requested mutation or artifact generation now, then verify its actual output.',
      }
    }
    const signature = installAttemptSignature(call)
    if (signature && s.executionConvergence.installAttempts.includes(signature)) {
      return {
        ok: false,
        code: 'execution_convergence_install_blocked',
        error: `The repeated dependency installation (${signature}) was blocked after the task failed to converge.`,
        retryable: false,
        blockedKind: 'repeated_install',
        hint: 'Use the dependency state already observed and execute the requested output-producing command. Only report a blocker when a concrete execution error proves the dependency is unusable.',
      }
    }
    return null
  }
}

export async function initializeSteering(s) {
  installArtifactSteeringContract(s)
  installTerminalCompletion(s)
  installSteeringMessageRuntime(s)
  initializeExecutionBudget(s)
  s.callTrackedModel = (options) => callTrackedModel(s, options)
  installConvergenceRuntime(s)
  if (s.restoredLocalHtmlDeliveryFailure) {
    const recovery = await s.handleLocalHtmlDeliveryFailure({
      failure: s.restoredLocalHtmlDeliveryFailure,
    })
    if (recovery.result) return { kind: 'return', value: recovery.result }
  }
  return { kind: 'next' }
}
