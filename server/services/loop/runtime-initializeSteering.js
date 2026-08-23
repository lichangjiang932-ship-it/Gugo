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

export function resolveExecutionBudgetOptions(job, restoredBudget) {
  if (!restoredBudget || typeof restoredBudget !== 'object') return restoredBudget
  // Historical checkpoints may carry the retired dollar gate. Strip it at
  // the recovery adapter boundary before constructing the technical
  // calls/tokens budget; the original checkpoint remains immutable.
  const executionBudget = { ...restoredBudget }
  delete executionBudget.maxCostUsd
  return executionBudget
}

export async function initializeSteering(s) {
  const {
    LIVE_STEERING_GUARD_MARKER,
    MAX_INSTALL_ATTEMPT_SIGNATURES,
    attachJobBudget,
    callModelWithContextRecovery,
    createJobBudget,
    createModelPhaseHeartbeat,
    createSubagentApprovalContext,
    createToolLoopGuard,
    getJobBudget,
    hasMutationExecutionIntent,
    installAttemptSignature,
    isContextLengthError,
    isForcedToolChoiceCompatibilityError,
    isProbeLikeCall,
    recordRecoveredModelResult,
    requestedArtifactOutputDirective,
    runModelStep,
    runWithModelBudget,
    stripEphemeralToolMediaMessages,
  } = s.d
  installArtifactSteeringContract(s)
  installTerminalCompletion(s)
  s.appendSteeringMessages = (messages = []) => {
      if (!messages.length) return 0
      // 用户干预改变了上下文,跨干预的重复调用不算死循环。
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
        // Preserve the user text verbatim. Do not summarize steering before the model sees it.
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
  // Chat turns are caller-scoped (user/session/turn) while the legacy shared
  // budget cache is keyed by job.id alone. Reusing that cache would let equal
  // caller-provided turn ids share counters across tenants and would also make
  // recovery depend on whether the process restarted. A chat execution always
  // rebuilds from its durable checkpoint; server-generated background jobs keep
  // their shared in-process budget across scheduler ticks.
  const usesSharedJobBudget = s.job && s.job.origin !== 'chat'
  const executionBudgetOptions = resolveExecutionBudgetOptions(s.job, s.restoredBudget)
  s.budget = s.runtimeBudget || (usesSharedJobBudget
      ? (getJobBudget(s.job) || attachJobBudget(s.job, executionBudgetOptions))
      : createJobBudget(executionBudgetOptions))
  s.callTrackedModel = async ({
      messages: modelMessages,
      tools: modelTools = [],
      toolChoice,
      consumeBudget,
      allowOverBudget = false,
      onTextDelta,
      onReasoningDelta: handleReasoningDelta,
      requestSignal = s.signal,
      assertRequestActive = null,
    }) => {
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
          // Keep the exact revocation value so nested model/provider catches can
          // distinguish it from an upstream failure and must not persist a
          // misleading failed/not-sent outcome for a request the host revoked.
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
      let forcedToolChoiceCompatibilityFallbackUsed = false
      try {
        assertActive()
        const request = await callModelWithContextRecovery({
          messages: modelMessages,
          ephemeralMessages,
          tools: modelTools,
          callModel: async (modelRequest) => {
            await heartbeat.beginRequest()
            const invoke = (requestPayload) => {
              let preparedInvocation = null
              return runModelStep({
                request: requestPayload,
                loopEvents: s.activeLoopEvents,
                context: s.loopEventContext({ phase: 'model-request' }),
                beforeRequest: async ({ request: preparedRequest, attempt }) => {
                  assertActive()
                  const fingerprint = fingerprintModelRequest(preparedRequest, {
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
                      fingerprint,
                      iteration: s.iter,
                      modelName: s.job?.modelName,
                      modelProviderId: s.job?.modelProviderId,
                      modelConfigRevision: s.job?.modelConfigRevision,
                      reconcileRequest: s.reconcileModelRequest,
                    })
                    assertActive()
                    s.restoredModelInvocation = null
                    s.modelInvocation = resolution.invocation || null
                    let recoveredBudgetError = null
                    if (resolution.kind === 'replay'
                      && resolution.invocation?.usageApplied === false) {
                      try {
                        recordRecoveredModelResult(s.budget, resolution.response, { allowOverBudget })
                      } catch (error) {
                        recoveredBudgetError = error
                      }
                      s.modelInvocation = {
                        ...resolution.invocation,
                        usageApplied: true,
                      }
                    }
                    if (resolution.checkpointRequired) {
                      assertActive()
                      await s.checkpointBarrier.flush({
                        meta: {
                          boundary: 'model-request-reconciled',
                          iteration: s.iter,
                          attempt: resolution.invocation.attempt,
                          modelRequestId: resolution.invocation.id,
                          outcome: resolution.invocation.status,
                          },
                        })
                      assertActive()
                    }
                    if (resolution.kind === 'replay') {
                      preparedInvocation = {
                        cached: true,
                        ...resolution,
                        ...(recoveredBudgetError ? { budgetError: recoveredBudgetError } : {}),
                      }
                      return { ...preparedRequest, modelRequestId: resolution.invocation.id }
                    }
                    recoveredNextAttempt = resolution.nextAttempt || null
                  }
                  assertActive()
                  const invocation = createModelInvocation({
                    fingerprint,
                    jobId: s.job?.id,
                    stepId: s.step?.id,
                    iteration: s.iter,
                    attempt: recoveredNextAttempt || attempt,
                    modelName: s.job?.modelName,
                    modelProviderId: s.job?.modelProviderId,
                    modelConfigRevision: s.job?.modelConfigRevision,
                  })
                  s.modelInvocation = invocation
                  preparedInvocation = { cached: false, invocation }
                  assertActive()
                  await s.checkpointBarrier.beforeSideEffect({
                    meta: {
                      boundary: 'model-request',
                      iteration: s.iter,
                      attempt,
                      modelRequestId: invocation.id,
                    },
                  })
                  assertActive()
                  return {
                    ...preparedRequest,
                    modelRequestId: invocation.id,
                    onProviderAttempt: async (providerAttempt) => {
                      assertActive()
                      if (s.modelInvocation?.id !== invocation.id
                        || s.modelInvocation?.status !== 'in_flight') {
                        const error = new Error('physical Provider attempt lost its model invocation fence')
                        error.code = 'MODEL_PROVIDER_ATTEMPT_CONFLICT'
                        error.retryable = false
                        error.unsafeToReplay = true
                        throw error
                      }
                      s.modelInvocation = appendModelProviderAttempt(
                        s.modelInvocation,
                        providerAttempt,
                      )
                      assertActive()
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
                      assertActive()
                    },
                  }
                },
                runModel: async (preparedRequest) => {
                  assertActive()
                  if (preparedInvocation?.cached) {
                    if (preparedInvocation.budgetError) throw preparedInvocation.budgetError
                    return preparedInvocation.response
                  }
                  const invocation = preparedInvocation?.invocation
                  try {
                    const response = await runWithModelBudget(
                      s.budget,
                      () => {
                        assertActive()
                        return s.runModel(preparedRequest)
                      },
                      { allowOverBudget },
                    )
                    assertActive()
                    const checkpointedInvocation = s.modelInvocation?.id === invocation.id
                      ? s.modelInvocation
                      : invocation
                    s.modelInvocation = {
                      ...checkpointedInvocation,
                      status: 'completed',
                      response: snapshotModelResponse(response),
                      usageApplied: true,
                    }
                    assertActive()
                    await s.checkpointBarrier.flush({
                      meta: {
                        boundary: 'model-response',
                        iteration: s.iter,
                        attempt: invocation.attempt,
                        modelRequestId: invocation.id,
                      },
                    })
                    assertActive()
                    return response
                  } catch (error) {
                    if (requestFenceFailures.has(error)) throw error
                    // Revocation wins over a simultaneous provider failure. The
                    // exact fence error is propagated and no outcome checkpoint
                    // is written after ownership of this request is lost.
                    assertActive()
                    if (error?.partialModelResult) {
                      assertActive()
                      const checkpointedInvocation = s.modelInvocation?.id === invocation.id
                        ? s.modelInvocation
                        : invocation
                      s.modelInvocation = {
                        ...checkpointedInvocation,
                        status: 'completed',
                        response: snapshotModelResponse(error.partialModelResult),
                        usageApplied: true,
                      }
                      assertActive()
                      await s.checkpointBarrier.flush({
                        meta: {
                          boundary: 'model-response',
                          iteration: s.iter,
                          attempt: invocation.attempt,
                          modelRequestId: invocation.id,
                        },
                      })
                      assertActive()
                      throw error
                    }
                    if (error?.code === 'CHECKPOINT_FLUSH_FAILED') {
                      error.unsafeToReplay = true
                      throw error
                    }
                    if (error?.modelRequestOutcome === 'not_sent') {
                      assertActive()
                      const checkpointedInvocation = s.modelInvocation?.id === invocation.id
                        ? s.modelInvocation
                        : invocation
                      s.modelInvocation = {
                        ...checkpointedInvocation,
                        status: 'not_sent',
                      }
                      assertActive()
                      await s.checkpointBarrier.flush({
                        meta: {
                          boundary: 'model-request-not-sent',
                          iteration: s.iter,
                          attempt: invocation.attempt,
                          modelRequestId: invocation.id,
                        },
                      })
                      assertActive()
                      throw error
                    }
                    if (error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
                      || error?.unsafeToReplay === true) {
                      // Preserve the durable in-flight invocation. Rewriting it
                      // as failed would authorize an explicit retry even though
                      // the provider may already be processing the same request.
                      throw error
                    }
                    const checkpointedInvocation = s.modelInvocation?.id === invocation.id
                      ? s.modelInvocation
                      : invocation
                    assertActive()
                    s.modelInvocation = {
                      ...checkpointedInvocation,
                      status: 'failed',
                      errorCode: String(error?.code || 'MODEL_CALL_FAILED'),
                    }
                    assertActive()
                    await s.checkpointBarrier.flush({
                      meta: {
                        boundary: 'model-request-failed',
                        iteration: s.iter,
                        attempt: invocation.attempt,
                        modelRequestId: invocation.id,
                      },
                    })
                    assertActive()
                    throw error
                  }
                },
              })
            }
            try {
              const response = await invoke(modelRequest)
              assertActive()
              return response
            } catch (error) {
              if (requestFenceFailures.has(error)) throw error
              assertActive()
              const forcedChoice = modelRequest?.toolChoice
              if (forcedToolChoiceCompatibilityFallbackUsed
                || !forcedChoice
                || typeof forcedChoice !== 'object'
                || !isForcedToolChoiceCompatibilityError(error)) {
                throw error
              }

              // A number of OpenAI-compatible servers support tools but reject
              // selecting one named function through tool_choice. The recovery
              // prompt and runtime validator still require the same generator,
              // so retry this logical request once without the incompatible wire
              // field instead of terminating an otherwise recoverable file task.
              forcedToolChoiceCompatibilityFallbackUsed = true
              const compatibleRequest = { ...modelRequest }
              delete compatibleRequest.toolChoice
              assertActive()
              await heartbeat.beginRequest()
              assertActive()
              const response = await invoke(compatibleRequest)
              assertActive()
              return response
            }
          },
          isContextLengthError,
          contextWindow: s.contextWindow,
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
            if (typeof handleReasoningDelta === 'function') {
              await handleReasoningDelta(text, metadata)
            }
          },
        })
        assertActive()
        if (request.recovery?.compacted === true) {
          assertActive()
          await observeLoopEvent({
            loopEvents: s.activeLoopEvents,
            event: 'compaction',
            value: {
              recovery: request.recovery,
              messages: request.messages,
            },
            context: s.loopEventContext({ phase: 'context-compaction' }),
          })
          assertActive()
        }
        assertActive()
        return {
          ...request,
          messages: stripEphemeralToolMediaMessages(request.messages),
        }
      } finally {
        await heartbeat.stop()
      }
    }
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
      const installSignature = installAttemptSignature(call)
      if (installSignature && s.executionConvergence.installAttempts.includes(installSignature)) {
        return {
          ok: false,
          code: 'execution_convergence_install_blocked',
          error: `The repeated dependency installation (${installSignature}) was blocked after the task failed to converge.`,
          retryable: false,
          blockedKind: 'repeated_install',
          hint: 'Use the dependency state already observed and execute the requested output-producing command. Only report a blocker when a concrete execution error proves the dependency is unusable.',
        }
      }
      return null
    }
  if (s.restoredLocalHtmlDeliveryFailure) {
      const restoredRecovery = await s.handleLocalHtmlDeliveryFailure({
        failure: s.restoredLocalHtmlDeliveryFailure,
      })
      if (restoredRecovery.result) return { kind: 'return', value: restoredRecovery.result }
    }
  return { kind: 'next' }
}
