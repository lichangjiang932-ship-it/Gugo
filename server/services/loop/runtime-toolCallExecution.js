export function createToolAuditLifecycle({
  state,
  call,
  toolName,
  args,
  writeToolAudit,
  now = Date.now,
}) {
  const startedAt = now()
  const auditStage = (stage, {
    auditArgs = args,
    auditResult = null,
    status = 'ok',
  } = {}) => {
    if (!state.job?.userId) return
    writeToolAudit({
      userId: state.job.userId,
      origin: state.approvalOrigin,
      toolName,
      callId: call.id,
      stage,
      args: auditArgs,
      result: auditResult,
      status,
      durationMs: ['finished', 'filtered', 'denied'].includes(stage)
        ? Math.max(0, now() - startedAt)
        : null,
    })
  }
  const auditOutcomeStatus = (value) => {
    if (value?.ok === true) return 'ok'
    if (value?.denied === true || value?.policyDenied === true || value?.deniedByUser === true) return 'denied'
    if (value?.cancelled === true || value?.code === 'cancelled') return 'cancelled'
    if (value?.code === 'timeout' || value?.timeout === true) return 'timeout'
    return 'error'
  }
  return { auditStage, auditOutcomeStatus }
}

export function createDynamicRegistrationGuard({
  state,
  call,
  toolName,
  args,
  getToolMetadata,
  matchesDynamicToolRegistration,
}) {
  const expectedRegistrationId = String(call.dynamicToolRegistrationId || '').trim() || null
  const validate = (validationArgs = args) => {
    const userId = state.job?.userId || null
    const metadata = getToolMetadata(toolName, { args: validationArgs, userId })
    if (expectedRegistrationId) {
      if (!matchesDynamicToolRegistration(toolName, expectedRegistrationId, { userId })) {
        return {
          ok: false,
          code: 'dynamic_tool_registration_changed',
          error: `The registered implementation for ${toolName} changed after its schema was shown to the model. The stale call was not executed.`,
          retryable: false,
          refreshToolCatalog: true,
        }
      }
      if (state.approvalMode === 'plan') {
        return {
          ok: false,
          denied: true,
          policyDenied: true,
          code: 'permission_mode_plan_dynamic_tool',
          error: `Plan mode does not execute dynamic capability ${toolName}, even when it replaces a builtin read-only name.`,
          retryable: false,
        }
      }
      return null
    }
    if (metadata.origin === 'plugin' || metadata.origin === 'mcp') {
      return {
        ok: false,
        code: 'dynamic_tool_registration_unbound',
        error: `The dynamic capability call for ${toolName} has no bound registration identity and was not executed.`,
        retryable: false,
        refreshToolCatalog: true,
      }
    }
    return null
  }
  return { expectedRegistrationId, validate }
}

export function createCallSideEffectBoundary({
  state,
  call,
  toolName,
  getToolMetadata,
  createSideEffectExecution,
  createSideEffectScope,
  sideEffectRecoveryBlock,
  conflictCode,
  unknownCode,
}) {
  return createSideEffectExecution({
    ledger: state.sideEffectLedger,
    isDurableSideEffect: (args) => getToolMetadata(toolName, {
      args,
      userId: state.job?.userId || null,
    }).isReadOnly !== true,
    toolName,
    call,
    job: state.job,
    step: state.step,
    approvalOrigin: state.approvalOrigin,
    approvalSessionId: state.approvalSessionId,
    createScope: createSideEffectScope,
    recoveryBlock: sideEffectRecoveryBlock,
    conflictCode,
    unknownCode,
  })
}

export function createToolAuthorizationContext({
  state,
  call,
  toolName,
  isTrustedInternalLoopPrincipal,
}) {
  const hasApprovalSubject = typeof state.job?.userId === 'string'
    && state.job.userId.trim().length > 0
  const trustedInternalExecution = !hasApprovalSubject
    && isTrustedInternalLoopPrincipal(state.approvalPrincipal)
  const checkpointPolicyProvenance = Object.hasOwn(call, 'checkpointPolicyProvenance')
    ? call.checkpointPolicyProvenance
    : null
  const checkpointHookAuthorizationProvenance = Object.hasOwn(call, 'checkpointHookAuthorizationProvenance')
    ? call.checkpointHookAuthorizationProvenance
    : null
  const expectedApprovalContext = (policyProvenance = checkpointPolicyProvenance) => ({
    userId: state.job?.userId || null,
    origin: state.approvalOrigin,
    jobId: state.approvalOrigin === 'chat' ? null : state.job?.id || null,
    stepId: state.approvalOrigin === 'chat' ? state.job?.id || null : state.step?.id || null,
    sessionId: state.approvalSessionId || null,
    toolName,
    policyProvenance,
  })
  return {
    hasApprovalSubject,
    trustedInternalExecution,
    checkpointPolicyProvenance,
    checkpointHookAuthorizationProvenance,
    expectedApprovalContext,
  }
}

export async function executeAuthorizedTool({
  state,
  iteration,
  call,
  toolName,
  executionArgs,
  gate,
  durableExecution,
  checkpointPolicyProvenance,
  resumedExecutingSideEffect,
  sideEffectExecution,
  expectedDynamicRegistrationId,
  finalAuthorizationCheck = null,
  dependencies,
}) {
  const {
    CHECKPOINT_FLUSH_ERROR_CODE,
    createToolAbortScope,
    executeToolWithRetry,
    getToolMetadata,
    isLoopPauseResult,
    isSuccessfulToolResult,
    normalizeArtifactIdList,
    rememberApprovedSubagentCall,
  } = dependencies
  const preparedSideEffect = sideEffectExecution.prepare(executionArgs, {
    resumeExecuting: resumedExecutingSideEffect,
  })
  if (preparedSideEffect.replayed) {
    return {
      result: preparedSideEffect.result,
      toolExecutionAttempted: false,
      artifactId: null,
      artifactIds: [],
      clarification: null,
    }
  }

  const sideEffectInput = preparedSideEffect.input
  rememberApprovedSubagentCall(state.subagentApprovalContext, toolName, executionArgs, gate)
  const executionMetadata = getToolMetadata(toolName, {
    args: executionArgs,
    userId: state.job?.userId || null,
  })
  const abortScope = createToolAbortScope(state.signal, executionMetadata.interruptBehavior)
  if (durableExecution) {
    await iteration.markCall(call, {
      checkpointStatus: 'executing',
      checkpointApprovalId: gate.approvalId || call.checkpointApprovalId || null,
      checkpointPolicyProvenance: gate.policyProvenance ?? checkpointPolicyProvenance ?? null,
      checkpointHookAuthorizationProvenance: gate.hookAuthorized
        ? gate.hookAuthorizationProvenance || null
        : null,
      checkpointExecutionArgs: executionArgs,
      checkpointReadOnly: executionMetadata.isReadOnly === true,
      idempotencyKey: call.idempotencyKey,
    })
  }

  let result
  let sideEffectStarted = false
  let toolReturned = false
  let authorizationBlocked = false
  try {
    let checkpointFailure = null
    result = await executeToolWithRetry({
      metadata: executionMetadata,
      signal: abortScope.signal,
      maxAttempts: sideEffectInput ? 1 : state.toolRetryMaxAttempts,
      baseDelayMs: state.toolRetryBaseDelayMs,
      rethrowErrors: Boolean(sideEffectInput),
      execute: async ({ attempt } = {}) => {
        try {
          await state.checkpointBarrier.beforeSideEffect({
            meta: {
              boundary: 'tool-execution',
              iteration: state.iter,
              attempt: Number(attempt) || 1,
              toolName,
              toolCallId: call.id,
            },
          })
          checkpointFailure = null
        } catch (error) {
          checkpointFailure = error
          throw error
        }
        if (typeof finalAuthorizationCheck === 'function') {
          let authorization
          try {
            authorization = await finalAuthorizationCheck()
          } catch {
            authorization = {
              proceed: false,
              code: 'hook_authorization_verification_failed',
              reason: 'Hook 授权验证失败，已保守拒绝执行',
            }
          }
          if (!authorization?.proceed) {
            authorizationBlocked = true
            const blockedResult = {
              ok: false,
              code: authorization?.code || 'hook_authorization_provenance_invalid',
              error: authorization?.reason || 'Hook 授权已失效，工具未执行',
              systemFailure: true,
              retryable: false,
            }
            if (sideEffectInput) {
              if (preparedSideEffect.resumedExecuting) {
                sideEffectExecution.blockResumedExecution()
              } else {
                sideEffectExecution.markExecuting(sideEffectInput)
                sideEffectExecution.finish(sideEffectInput, blockedResult, () => false)
              }
            }
            return blockedResult
          }
        }
        if (sideEffectInput && !preparedSideEffect.resumedExecuting) {
          sideEffectExecution.markExecuting(sideEffectInput)
        }
        if (sideEffectInput) sideEffectStarted = true
        const toolResult = await state.executeTool({
          name: toolName,
          args: executionArgs,
          job: state.activeArtifactOutputPrompt
            ? { ...state.job, userPrompt: state.activeArtifactOutputPrompt }
            : state.job,
          step: state.step,
          signal: abortScope.signal,
          budget: state.budget,
          skillId: state.explicitSkillId || null,
          toolCallId: call.id,
          idempotencyKey: call.idempotencyKey,
          idempotentResume: preparedSideEffect.resumedExecuting === true,
          sideEffectRecoveryPlan: sideEffectInput ? Object.freeze({
            prepare: (plan) => sideEffectExecution.prepareRecoveryPlan(sideEffectInput, plan),
            read: () => sideEffectExecution.readRecoveryPlan(sideEffectInput),
          }) : null,
          approvalContext: state.subagentApprovalContext,
          allowedArtifactTools: state.stepArtifactTools,
          requiresLocalArtifactDelivery: state.requiresLocalArtifactDelivery,
          dynamicToolRegistrationId: expectedDynamicRegistrationId,
        })
        toolReturned = true
        return toolResult
      },
    })
    if (checkpointFailure) throw checkpointFailure
    if (sideEffectInput && !authorizationBlocked) {
      sideEffectExecution.finish(sideEffectInput, result, isSuccessfulToolResult)
    }
  } catch (error) {
    sideEffectExecution.rethrowExecutionError({
      error,
      input: sideEffectInput,
      started: sideEffectStarted,
      returned: toolReturned,
      result,
      checkpointFlushErrorCode: CHECKPOINT_FLUSH_ERROR_CODE,
    })
  } finally {
    abortScope.dispose()
  }

  if (gate.authorization && result && typeof result === 'object') {
    result = { ...result, approvalAuthorization: gate.authorization }
  }
  const artifactId = result?.artifactId || null
  const artifactIds = normalizeArtifactIdList(result?.artifactIds)
  if (artifactIds.length === 0 && artifactId) artifactIds.push(String(artifactId))
  return {
    result,
    toolExecutionAttempted: !authorizationBlocked,
    artifactId,
    artifactIds,
    clarification: isLoopPauseResult(result) ? result.clarification : null,
  }
}

export async function finalizeToolCallOutcome({
  state,
  call,
  result,
  executionArgs,
  toolExecutionAttempted,
  auditTerminalStage,
  auditStage,
  auditOutcomeStatus,
  resumedExecutingSideEffect,
  sideEffectExecution,
  runPostTool,
  artifactId,
  artifactIds,
  clarification,
  budgetExceeded,
  noProgressReason,
}) {
  if (resumedExecutingSideEffect && !toolExecutionAttempted) {
    // A current policy/configuration/validation gate rejected the recovery. The
    // old attempt still has no proven outcome, so never leave it resumable.
    sideEffectExecution.blockResumedExecution()
  }

  try {
    await runPostTool({
      loopEvents: state.activeLoopEvents,
      call: { ...call, args: executionArgs },
      result,
      context: state.loopEventContext({
        phase: 'post-tool',
        executed: toolExecutionAttempted,
      }),
    })
  } catch {
    // The outcome is final. Observer failures must not cause a replay.
  }

  if (toolExecutionAttempted) {
    auditStage('finished', {
      auditArgs: executionArgs,
      auditResult: result,
      status: auditOutcomeStatus(result),
    })
  } else if (!auditTerminalStage) {
    auditStage('filtered', {
      auditArgs: executionArgs,
      auditResult: result,
      status: auditOutcomeStatus(result),
    })
  }

  return {
    call,
    executionArgs,
    result,
    artifactId,
    artifactIds,
    clarification,
    budgetExceeded,
    noProgressReason,
  }
}
