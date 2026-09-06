import { assertRuntimeStage } from './runtimeContract.js'
import {
  createCallSideEffectBoundary,
  createDynamicRegistrationGuard,
  createToolAuthorizationContext,
  createToolAuditLifecycle,
  executeAuthorizedTool,
  finalizeToolCallOutcome,
} from './runtime-toolCallExecution.js'

function truncatedToolOutcome(s, call) {
  const { name, args } = call
  const result = s.d.createTruncatedToolCallResult(call, {
    reason: call.modelOutputTruncationReason,
  })
  const { auditStage, auditOutcomeStatus } = createToolAuditLifecycle({
    state: s, call, toolName: name, args, writeToolAudit: s.d.writeToolAudit,
  })
  auditStage('proposed')
  auditStage('filtered', { auditResult: result, status: auditOutcomeStatus(result) })
  return {
    call,
    executionArgs: args,
    result,
    artifactId: null,
    artifactIds: [],
    clarification: null,
    budgetExceeded: null,
    noProgressReason: null,
  }
}

async function prepareToolCallExecution(s, call) {
  if (s.signal?.aborted) {
    const error = new Error('Turn cancelled')
    error.name = 'AbortError'
    throw error
  }
  const preparedCall = await s.d.runPreTool({
    loopEvents: s.activeLoopEvents,
    call,
    context: s.loopEventContext({ phase: 'pre-tool' }),
  })
  if (preparedCall !== call) Object.assign(call, preparedCall)
  const { name, args } = call
  const audit = createToolAuditLifecycle({
    state: s, call, toolName: name, args, writeToolAudit: s.d.writeToolAudit,
  })
  audit.auditStage('proposed')
  audit.auditStage('started')
  if (typeof s.onToolStarted === 'function') await s.onToolStarted(call)
  const repeatReminder = s.repeatCallGuard.record(name, args)
  if (repeatReminder) s.pendingRepeatCallReminder = repeatReminder
  const dynamicGuard = createDynamicRegistrationGuard({
    state: s, call, toolName: name, args,
    getToolMetadata: s.d.getToolMetadata,
    matchesDynamicToolRegistration: s.d.matchesDynamicToolRegistration,
  })
  const checkpointExecutionArgs = call.checkpointExecutionArgs ?? args
  const sideEffectExecution = createCallSideEffectBoundary({
    state: s,
    call,
    toolName: name,
    getToolMetadata: s.d.getToolMetadata,
    createSideEffectExecution: s.d.createSideEffectExecution,
    createSideEffectScope: s.d.createSideEffectScope,
    sideEffectRecoveryBlock: s.d.sideEffectRecoveryBlock,
    conflictCode: s.d.SIDE_EFFECT_LEDGER_CONFLICT,
    unknownCode: s.d.SIDE_EFFECT_OUTCOME_UNKNOWN,
  })
  const idempotentResume = call.checkpointStatus === 'executing'
    && s.d.supportsIdempotentResume(s.executeTool, {
      name,
      args: checkpointExecutionArgs,
      job: s.job,
      step: s.step,
      toolCallId: call.id,
      idempotencyKey: call.idempotencyKey,
    })
  const recovery = sideEffectExecution.recover(checkpointExecutionArgs, {
    allowIdempotentResume: idempotentResume,
  })
  const context = {
    call, name, args,
    executionArgsUsed: args,
    auditTerminalStage: null,
    toolExecutionAttempted: false,
    result: recovery.result,
    outcomeBudgetExceeded: null,
    outcomeNoProgressReason: null,
    clarification: null,
    artifactId: null,
    artifactIds: [],
    expectedDynamicRegistrationId: dynamicGuard.expectedRegistrationId,
    dynamicRegistrationValidationError: dynamicGuard.validate,
    checkpointExecutionArgs,
    sideEffectExecution,
    idempotentResume,
    resumedPreparedSideEffect: recovery.resumedPrepared,
    resumedExecutingSideEffect: recovery.resumedExecuting || false,
    isFree: ['reflect', 'request_clarification', 'request_directory', 'sleep_until', 'set_deliverables']
      .includes(name),
    audit,
  }
  if (!context.result) {
    context.result = dynamicGuard.validate(checkpointExecutionArgs)
      || s.disabledToolValidationError(name)
      || (call.checkpointStatus === 'executing'
        ? s.explicitReadOnlyValidationError(name, checkpointExecutionArgs)
        : null)
  }
  if (!context.result && call.checkpointStatus === 'executing'
    && call.checkpointReadOnly !== true
    && !idempotentResume
    && !context.resumedPreparedSideEffect) {
    context.result = {
      ok: false,
      code: 'tool_execution_outcome_unknown',
      error: `The service restarted while ${name} was executing. It was not replayed because its side effects may already have happened.`,
      retryable: false,
      requiresUserVerification: true,
    }
  }
  return context
}

function refreshDynamicExecutionTools(s, context) {
  const { DYNAMIC_EXECUTION_TOOL_NAMES, VERIFICATION_TOOLS,
    isCommandExecutionTool, replaceRuntimeCapabilityBlock,
    restoreNamedToolSpecs, toolNameFromSpec } = s.d
  if (!DYNAMIC_EXECUTION_TOOL_NAMES.has(context.name)
    || s.capabilityMode !== 'execute'
    || s.approvalMode !== 'bypass'
    || s.activeToolSpecs.some((spec) => toolNameFromSpec(spec) === context.name)) return
  const refreshed = restoreNamedToolSpecs(
    s.activeToolSpecs,
    s.eligibleFallbackToolSpecs,
    DYNAMIC_EXECUTION_TOOL_NAMES,
  )
  if (!refreshed.some((spec) => toolNameFromSpec(spec) === context.name)) return
  const previousNames = new Set(s.activeToolSpecs.map(toolNameFromSpec).filter(Boolean))
  s.activeToolSpecs = refreshed
  for (const spec of refreshed) {
    const name = toolNameFromSpec(spec)
    if (DYNAMIC_EXECUTION_TOOL_NAMES.has(name) && !previousNames.has(name)) {
      s.dynamicallyMountedToolNames.add(name)
    }
  }
  s.convo = replaceRuntimeCapabilityBlock(s.convo, {
    toolSpecs: s.activeToolSpecs,
    approvalMode: s.approvalMode,
    ...s.outputDirectoryContext,
  })
  s.availableVerificationToolNames = s.activeToolSpecs.map(toolNameFromSpec)
    .filter((name) => VERIFICATION_TOOLS.has(name) || isCommandExecutionTool(name))
}

function applyToolExecutionGuards(s, context) {
  const { call, name, args } = context
  const convergenceBlock = s.convergenceBlockFor(call)
  const forcedAttempt = s.forcedArtifactRequestPending()
    && name === s.forcedArtifactToolName
    && !s.hasRequiredArtifacts()
  if (forcedAttempt) s.loopGuard.resetRepetition?.()
  const guard = convergenceBlock
    ? { ok: false, result: convergenceBlock, convergenceBlocked: true }
    : s.loopGuard.before(call)
  if (!guard.ok) {
    context.result = guard.result
    if (!guard.convergenceBlocked) context.outcomeNoProgressReason = guard.reason
    return
  }
  if (!context.isFree) {
    const budget = s.budget.consume(1)
    if (!budget.ok) {
      context.outcomeBudgetExceeded = budget.reason
      context.result = {
        ok: false, code: 'tool_budget_exceeded', error: budget.reason, retryable: false,
      }
    }
  }
  if (!context.result) context.result = s.redundantImageGenerationGuard(name)
  if (!context.result && s.d.isFileArtifactTool(name) && !s.stepArtifactTools.has(name)) {
    context.result = {
      ok: false,
      code: 'artifact_tool_not_requested',
      error: `用户没有要求生成 ${name} 这类文件产物,该工具在本次任务中不可用。`,
      retryable: false,
      hint: '直接完成用户真正要求的工作(如修改代码、给出结论),并用文字说明结果;不要用文件代替交付。',
    }
  }
  if (!context.result) {
    context.result = s.artifactReplacementValidationError(name, args)
      || s.workspaceTargetValidationError(name, args)
  }
  if (!context.result) refreshDynamicExecutionTools(s, context)
  if (!context.result) {
    context.result = s.d.validateToolCall(call, s.activeToolSpecs, {
      allowUnknown: s.executeTool !== s.d.executeServerTool,
    })
  }
  if (!context.result) context.result = s.explicitReadOnlyValidationError(name, args)
  if (!context.result && name === 'request_directory' && s.hasVerifiedDirectoryResolution) {
    context.result = {
      ok: false,
      code: 'directory_authorization_already_resolved',
      error: 'The requested local directory authorization is already persisted and verified for this turn.',
      retryable: false,
      hint: 'Do not request the directory again. Continue the original task now using the exact authorized path and access mode from the TURN_RESOLUTION system message.',
    }
  }
  if (!context.result && name === 'request_clarification') {
    context.result = s.d.contradictedCapabilityClarification(args, s.activeToolSpecs, s.convo)
  }
  if (!context.result && name === 'set_deliverables') {
    try {
      context.result = s.selectDeliverables(args)
      if (context.result?.ok !== true && s.deliveryContractReadyForSelection()) {
        s.deliverableSelectionRetries += 1
      }
    } catch (error) {
      context.result = s.d.normalizeToolError(error)
      if (s.deliveryContractReadyForSelection()) s.deliverableSelectionRetries += 1
    }
  }
}

async function resolveResumedAuthorization(s, context, authorization) {
  const { call, name } = context
  let effectiveArgs = call.checkpointExecutionArgs ?? context.args
  let gate
  if (call.checkpointApprovalId) {
    gate = await s.d.resumePersistedApproval({
      approvalId: call.checkpointApprovalId,
      signal: s.signal,
      requireTerminal: true,
      expectedApprovalContext: authorization.expectedApprovalContext(),
    })
    if (gate.proceed) {
      const approvedArgs = gate.args ?? effectiveArgs
      if (JSON.stringify(approvedArgs) !== JSON.stringify(effectiveArgs)) {
        gate = {
          proceed: false,
          reason: '审批参数与执行快照不一致，已保守拒绝恢复执行',
          code: 'approval_context_mismatch',
          approvalContextMismatch: true,
          retryable: false,
          approvalId: call.checkpointApprovalId,
          policyProvenance: gate.policyProvenance || null,
        }
      }
    }
  } else if (authorization.trustedInternalExecution) {
    gate = { proceed: true, args: effectiveArgs, trustedInternal: true }
  } else if (authorization.checkpointHookAuthorizationProvenance) {
    const hook = s.d.revalidateHookAuthorization({
      provenance: authorization.checkpointHookAuthorizationProvenance,
      userId: s.job?.userId || null,
      origin: s.approvalOrigin,
      jobId: s.approvalOrigin === 'chat' ? null : s.job?.id || null,
      stepId: s.approvalOrigin === 'chat' ? s.job?.id || null : s.step?.id || null,
      sessionId: s.approvalSessionId || null,
      requestId: s.step?.id || null,
      toolCallId: call.id,
      toolName: name,
      args: effectiveArgs,
      requireLive: false,
    })
    if (!hook.proceed) gate = hook
    else {
      const policy = s.d.revalidateToolPermission({
        userId: s.job?.userId || null,
        origin: s.approvalOrigin,
        toolName: name,
        args: effectiveArgs,
        taskGrants: s.job?.sourceType === 'cron' ? s.job.grants : [],
        expectedPolicyProvenance: authorization.checkpointPolicyProvenance,
        allowAsk: !s.d.requiresPerCallApproval(name),
      })
      gate = policy.proceed
        ? { ...policy, hookAuthorized: true, hookAuthorizationProvenance: hook.hookAuthorizationProvenance }
        : policy
    }
  } else {
    gate = s.d.revalidateToolPermission({
      userId: s.job?.userId || null,
      origin: s.approvalOrigin,
      toolName: name,
      args: effectiveArgs,
      taskGrants: s.job?.sourceType === 'cron' ? s.job.grants : [],
      expectedPolicyProvenance: authorization.checkpointPolicyProvenance,
      allowAsk: false,
    })
  }
  return {
    effectiveArgs,
    gate: { ...gate, approvalId: call.checkpointApprovalId || null, resumedIdempotentExecution: true },
  }
}

async function resolveFreshAuthorization(s, i, context, authorization) {
  const { call, name, args } = context
  let effectiveArgs = args
  let gate = null
  let hookAuthorizationProvenance = null
  let hookRequiresApproval = false
  let hookApprovalReason = null
  if (call.checkpointStatus === 'awaiting_approval' && call.checkpointApprovalId) {
    gate = await s.d.resumePersistedApproval({
      approvalId: call.checkpointApprovalId,
      signal: s.signal,
      expectedApprovalContext: authorization.expectedApprovalContext(),
    })
    effectiveArgs = gate.args ?? effectiveArgs
    return { effectiveArgs, gate }
  }
  if (s.enableToolHooks && s.job?.userId) {
    const preHook = call[s.d.TOOL_HOOK_RESULT]
    if (preHook && !preHook.allow) {
      context.result = {
        ok: false, denied: true, code: 'hook_denied',
        error: preHook.reason || `pre_tool_use hook denied ${name}`, retryable: false,
      }
    } else if (preHook?.replacementArgs && typeof preHook.replacementArgs === 'object') {
      effectiveArgs = preHook.replacementArgs
    }
    if (preHook?.permissionDecision === 'allow') {
      hookAuthorizationProvenance = preHook.hookAuthorizationProvenance || null
    }
    if (preHook?.permissionDecision === 'ask') {
      hookRequiresApproval = true
      hookApprovalReason = preHook.reason || null
    }
  }
  if (!context.result && effectiveArgs !== args) {
    context.result = s.d.validateToolCall(
      { ...call, args: effectiveArgs },
      s.activeToolSpecs,
      { allowUnknown: s.executeTool !== s.d.executeServerTool },
    ) || s.explicitReadOnlyValidationError(name, effectiveArgs)
  }
  if (!context.result) {
    gate = authorization.trustedInternalExecution
      ? { proceed: true, args: effectiveArgs, trustedInternal: true }
      : !authorization.hasApprovalSubject
        ? s.d.revalidateToolPermission({
            userId: s.job?.userId || null,
            origin: s.approvalOrigin,
            toolName: name,
            args: effectiveArgs,
            taskGrants: s.job?.sourceType === 'cron' ? s.job.grants : [],
          })
        : await s.requestToolApproval({
            userId: s.job.userId,
            origin: s.approvalOrigin,
            jobId: s.approvalOrigin === 'chat' ? null : s.job?.id || null,
            stepId: s.approvalOrigin === 'chat' ? s.job?.id || null : s.step?.id || null,
            sessionId: s.approvalSessionId,
            toolName: name,
            args: effectiveArgs,
            signal: s.signal,
            mode: s.approvalMode,
            forceApproval: hookRequiresApproval,
            forceApprovalReason: hookApprovalReason,
            hookAuthorizationProvenance,
            requestId: s.step?.id || null,
            toolCallId: call.id,
            taskGrants: s.job?.sourceType === 'cron' ? s.job.grants : [],
            onPending: async (approval) => {
              context.audit.auditStage('approval_requested', { auditArgs: approval.args ?? effectiveArgs })
              await i.markCall(call, {
                checkpointStatus: 'awaiting_approval',
                checkpointApprovalId: approval.id,
                checkpointPolicyProvenance: approval.policyProvenance ?? null,
                checkpointHookAuthorizationProvenance: null,
                checkpointExecutionArgs: approval.args ?? effectiveArgs,
              })
              if (typeof s.onApprovalPending === 'function') await s.onApprovalPending(approval)
            },
          })
  }
  return { effectiveArgs, gate }
}

function revalidateAuthorization(s, context, authorization, effectiveArgs, gate) {
  if (!gate?.proceed || gate.resumedIdempotentExecution || authorization.trustedInternalExecution) {
    return gate
  }
  let verifiedHookAuthorization = false
  if (gate.hookAuthorized) {
    const hook = s.d.revalidateHookAuthorization({
      provenance: gate.hookAuthorizationProvenance,
      userId: s.job?.userId || null,
      origin: s.approvalOrigin,
      jobId: s.approvalOrigin === 'chat' ? null : s.job?.id || null,
      stepId: s.approvalOrigin === 'chat' ? s.job?.id || null : s.step?.id || null,
      sessionId: s.approvalSessionId || null,
      requestId: s.step?.id || null,
      toolCallId: context.call.id,
      toolName: context.name,
      args: gate.args ?? effectiveArgs,
      requireLive: true,
    })
    if (!hook.proceed) return { ...hook, policyProvenance: gate.policyProvenance }
    verifiedHookAuthorization = true
  }
  const policy = s.d.revalidateToolPermission({
    userId: s.job?.userId || null,
    origin: s.approvalOrigin,
    toolName: context.name,
    args: gate.args ?? effectiveArgs,
    taskGrants: s.job?.sourceType === 'cron' ? s.job.grants : [],
    expectedPolicyProvenance: Object.hasOwn(gate, 'policyProvenance') ? gate.policyProvenance : null,
    allowAsk: Boolean(gate.approvalId
      || (verifiedHookAuthorization && !s.d.requiresPerCallApproval(context.name))),
  })
  return policy.proceed
    ? { ...gate, authorization: gate.authorization || policy.authorization || null,
        policyProvenance: policy.policyProvenance }
    : { ...policy, approvalId: gate.approvalId || null }
}

async function authorizeAndExecuteTool(s, i, context, durableExecution) {
  const authorization = createToolAuthorizationContext({
    state: s,
    call: context.call,
    toolName: context.name,
    isTrustedInternalLoopPrincipal: s.d.isTrustedInternalLoopPrincipal,
  })
  const resumed = context.idempotentResume || context.resumedPreparedSideEffect
  const resolved = resumed
    ? await resolveResumedAuthorization(s, context, authorization)
    : await resolveFreshAuthorization(s, i, context, authorization)
  let { effectiveArgs, gate } = resolved
  if (context.result) return
  gate = revalidateAuthorization(s, context, authorization, effectiveArgs, gate)
  if (gate && !gate.proceed) {
    context.result = s.d.formatDeniedToolResult(gate)
    context.auditTerminalStage = 'denied'
    context.audit.auditStage('denied', {
      auditArgs: gate.args ?? effectiveArgs,
      auditResult: context.result,
      status: 'denied',
    })
  } else if (gate) {
    const executionArgs = gate.args ?? effectiveArgs
    context.executionArgsUsed = executionArgs
    context.audit.auditStage(gate.approvalId ? 'approved' : 'auto_allowed', {
      auditArgs: executionArgs,
      auditResult: gate.authorization
        ? {
            grantSource: gate.authorization.source || gate.authorization.kind || null,
            grantKind: gate.authorization.kind || null,
          }
        : null,
    })
    const finalValidationError = context.dynamicRegistrationValidationError(executionArgs)
      || s.redundantImageGenerationGuard(context.name)
      || s.d.validateToolCall(
        { ...context.call, args: executionArgs },
        s.activeToolSpecs,
        { allowUnknown: s.executeTool !== s.d.executeServerTool },
      )
      || s.explicitReadOnlyValidationError(context.name, executionArgs)
      || s.artifactReplacementValidationError(context.name, executionArgs)
      || s.workspaceTargetValidationError(context.name, executionArgs)
    if (finalValidationError) context.result = finalValidationError
    else {
      const execution = await executeAuthorizedTool({
        state: s,
        iteration: i,
        call: context.call,
        toolName: context.name,
        executionArgs,
        gate,
        durableExecution,
        checkpointPolicyProvenance: authorization.checkpointPolicyProvenance,
        resumedExecutingSideEffect: context.resumedExecutingSideEffect,
        sideEffectExecution: context.sideEffectExecution,
        expectedDynamicRegistrationId: context.expectedDynamicRegistrationId,
        finalAuthorizationCheck: gate.hookAuthorized
          ? () => s.d.revalidateHookAuthorization({
              provenance: gate.hookAuthorizationProvenance,
              userId: s.job?.userId || null,
              origin: s.approvalOrigin,
              jobId: s.approvalOrigin === 'chat' ? null : s.job?.id || null,
              stepId: s.approvalOrigin === 'chat' ? s.job?.id || null : s.step?.id || null,
              sessionId: s.approvalSessionId || null,
              requestId: s.step?.id || null,
              toolCallId: context.call.id,
              toolName: context.name,
              args: executionArgs,
              requireLive: true,
            })
          : null,
        dependencies: {
          CHECKPOINT_FLUSH_ERROR_CODE: s.d.CHECKPOINT_FLUSH_ERROR_CODE,
          createToolAbortScope: s.d.createToolAbortScope,
          executeToolWithRetry: s.d.executeToolWithRetry,
          getToolMetadata: s.d.getToolMetadata,
          isLoopPauseResult: s.d.isLoopPauseResult,
          isSuccessfulToolResult: s.d.isSuccessfulToolResult,
          normalizeArtifactIdList: s.d.normalizeArtifactIdList,
          rememberApprovedSubagentCall: s.d.rememberApprovedSubagentCall,
        },
      })
      Object.assign(context, execution)
    }
  }
  if (gate?.approvalId && !gate.resumedIdempotentExecution
    && typeof s.onApprovalResolved === 'function') {
    try { await s.onApprovalResolved(gate) } catch { /* outcome already authoritative */ }
  }
}

async function executeOneToolCall(s, call, { durableExecution = true } = {}) {
  if (s.signal?.aborted) {
    const error = new Error('Turn cancelled')
    error.name = 'AbortError'
    throw error
  }
  if (call.modelOutputTruncated) return truncatedToolOutcome(s, call)
  const context = await prepareToolCallExecution(s, call)
  if (!context.result) applyToolExecutionGuards(s, context)
  if (!context.result) {
    try {
      await authorizeAndExecuteTool(s, s.iteration, context, durableExecution)
    } catch (error) {
      if (s.signal?.aborted || error?.name === 'AbortError') throw error
      if (error?.code === s.d.CHECKPOINT_FLUSH_ERROR_CODE || error?.unsafeToReplay === true) throw error
      context.result = s.d.normalizeToolError(error)
    }
  }
  return finalizeToolCallOutcome({
    state: s,
    call,
    result: context.result,
    executionArgs: context.executionArgsUsed,
    toolExecutionAttempted: context.toolExecutionAttempted,
    auditTerminalStage: context.auditTerminalStage,
    auditStage: context.audit.auditStage,
    auditOutcomeStatus: context.audit.auditOutcomeStatus,
    resumedExecutingSideEffect: context.resumedExecutingSideEffect,
    sideEffectExecution: context.sideEffectExecution,
    runPostTool: s.d.runPostTool,
    artifactId: context.artifactId,
    artifactIds: context.artifactIds,
    clarification: context.clarification,
    budgetExceeded: context.outcomeBudgetExceeded,
    noProgressReason: context.outcomeNoProgressReason,
  })
}

export async function executeToolCalls(s) {
  assertRuntimeStage(s, 'execute-tool-calls')
  const i = s.iteration
  i.pausedByClarification = null
  i.budgetExceededByCompletedModelResponse = s.modelBudgetExceededAfterResponse
  s.modelBudgetExceededAfterResponse = null
  i.budgetExceeded = i.budgetExceededByCompletedModelResponse
  i.noProgressReason = null
  i.noProgressCode = null
  i.noProgressFailure = null
  i.markCall = async (call, updates) => {
    Object.assign(call, updates)
    await s.persistTurn()
  }
  s.d.installToolFailureRecovery(s, i)
  i.executeOne = (call, options) => executeOneToolCall(s, call, options)
  return { kind: 'next' }
}
