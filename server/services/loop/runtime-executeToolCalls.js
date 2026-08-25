import { assertRuntimeStage } from './runtimeContract.js'
import {
  createCallSideEffectBoundary,
  createDynamicRegistrationGuard,
  createToolAuthorizationContext,
  createToolAuditLifecycle,
  executeAuthorizedTool,
  finalizeToolCallOutcome,
} from './runtime-toolCallExecution.js'

export async function executeToolCalls(s) {
  assertRuntimeStage(s, 'execute-tool-calls')
  const i = s.iteration
  const { CHECKPOINT_FLUSH_ERROR_CODE, DYNAMIC_EXECUTION_TOOL_NAMES, SIDE_EFFECT_LEDGER_CONFLICT, SIDE_EFFECT_OUTCOME_UNKNOWN, TOOL_HOOK_RESULT, VERIFICATION_TOOLS, contradictedCapabilityClarification, createSideEffectExecution, createSideEffectScope, createToolAbortScope, createTruncatedToolCallResult, executeServerTool, executeToolWithRetry, formatDeniedToolResult, getToolMetadata, installToolFailureRecovery, isCommandExecutionTool, isFileArtifactTool, isLoopPauseResult, isSuccessfulToolResult, isTrustedInternalLoopPrincipal, matchesDynamicToolRegistration, normalizeArtifactIdList, normalizeToolError, rememberApprovedSubagentCall, replaceRuntimeCapabilityBlock, restoreNamedToolSpecs, resumePersistedApproval, revalidateHookAuthorization, revalidateToolPermission, runPostTool, runPreTool, sideEffectRecoveryBlock, supportsIdempotentResume, toolNameFromSpec, validateToolCall, writeToolAudit } = s.d
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
  installToolFailureRecovery(s, i)
  i.executeOne = async (call, { durableExecution = true } = {}) => {
        if (s.signal?.aborted) {
          const error = new Error('Turn cancelled')
          error.name = 'AbortError'
          throw error
        }
        if (call.modelOutputTruncated) {
          const { name, args } = call
          const result = createTruncatedToolCallResult(call, {
            reason: call.modelOutputTruncationReason,
          })
          const { auditStage, auditOutcomeStatus } = createToolAuditLifecycle({
            state: s, call, toolName: name, args, writeToolAudit,
          })
          auditStage('proposed')
          auditStage('filtered', {
            auditResult: result,
            status: auditOutcomeStatus(result),
          })
          // Truncation is an input-integrity failure, not a tool attempt. Keep
          // the paired result but never enter pre/post hooks, approvals,
          // side-effect recovery, onToolStarted, or the executor.
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
        const preparedCall = await runPreTool({
          loopEvents: s.activeLoopEvents,
          call,
          context: s.loopEventContext({ phase: 'pre-tool' }),
        })
        // Waterfall listeners may return a cloned call (the built-in hook
        // bridge does this even when it only attaches hook metadata). Keep the
        // checkpoint batch's canonical object identity so approval/execution
        // statuses are persisted before any side effect and completion is not
        // recorded only on an untracked clone.
        if (preparedCall !== call) Object.assign(call, preparedCall)
        const { name, args } = call
        let auditTerminalStage = null
        let toolExecutionAttempted = false
        const { auditStage, auditOutcomeStatus } = createToolAuditLifecycle({
          state: s, call, toolName: name, args, writeToolAudit,
        })
        auditStage('proposed')
        auditStage('started')
        if (typeof s.onToolStarted === 'function') await s.onToolStarted(call)
        // ★ 死循环 advisory：连续发出「同一工具 + 相同参数」时,记一条待注入提醒。
        // 只提醒不拦截 —— 模型自己决定换策略还是收尾(见 repeatCallGuard)。
        const repeatReminder = s.repeatCallGuard.record(name, args)
        if (repeatReminder) s.pendingRepeatCallReminder = repeatReminder
        let executionArgsUsed = args
        // ★ M3.5:预算检查(reflect/request_clarification 不计,鼓励复盘与澄清)
        const isFree = name === 'reflect' || name === 'request_clarification' || name === 'request_directory' || name === 'sleep_until' || name === 'set_deliverables'
        let result
        let outcomeBudgetExceeded = null
        let outcomeNoProgressReason = null
        let clarification = null
        let artifactId = null
        let artifactIds = []
        const {
          expectedRegistrationId: expectedDynamicRegistrationId,
          validate: dynamicRegistrationValidationError,
        } = createDynamicRegistrationGuard({
          state: s, call, toolName: name, args, getToolMetadata, matchesDynamicToolRegistration,
        })
        const checkpointExecutionArgs = call.checkpointExecutionArgs ?? args
        const sideEffectExecution = createCallSideEffectBoundary({
          state: s, call, toolName: name, getToolMetadata, createSideEffectExecution,
          createSideEffectScope, sideEffectRecoveryBlock,
          conflictCode: SIDE_EFFECT_LEDGER_CONFLICT,
          unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN,
        })
        const idempotentResume = call.checkpointStatus === 'executing'
          && supportsIdempotentResume(s.executeTool, {
            name,
            args: checkpointExecutionArgs,
            job: s.job,
            step: s.step,
            toolCallId: call.id,
            idempotencyKey: call.idempotencyKey,
          })
        const {
          resumedPrepared: resumedPreparedSideEffect,
          resumedExecuting: resumedExecutingSideEffect = false,
          result: recoveredLedgerResult,
        } = sideEffectExecution.recover(checkpointExecutionArgs, {
          allowIdempotentResume: idempotentResume,
        })
        const readOnlyResumeValidationError = call.checkpointStatus === 'executing'
          ? s.explicitReadOnlyValidationError(name, checkpointExecutionArgs)
          : null
        const registrationValidationError = dynamicRegistrationValidationError(checkpointExecutionArgs)
        const configuredToolValidationError = s.disabledToolValidationError(name)
        if (recoveredLedgerResult) {
          result = recoveredLedgerResult
        } else if (registrationValidationError) {
          result = registrationValidationError
        } else if (configuredToolValidationError) {
          // The schema remains visible by design, but the execution switch is
          // authoritative for fresh calls, awaiting approvals and executing
          // checkpoints alike. Run this before hooks/approval/idempotent resume.
          result = configuredToolValidationError
        } else if (readOnlyResumeValidationError) {
          result = readOnlyResumeValidationError
        } else if (call.checkpointStatus === 'executing'
          && call.checkpointReadOnly !== true
          && !idempotentResume
          && !resumedPreparedSideEffect) {
          // We cannot prove whether a side effect committed before the process
          // stopped. Never replay it automatically: report the uncertainty to
          // the model so it can verify state or ask the user how to proceed.
          result = {
            ok: false,
            code: 'tool_execution_outcome_unknown',
            error: `The service restarted while ${name} was executing. It was not replayed because its side effects may already have happened.`,
            retryable: false,
            requiresUserVerification: true,
          }
        } else {
          const convergenceBlock = s.convergenceBlockFor(call)
          const boundedForcedArtifactAttempt = s.forcedArtifactRequestPending()
            && call.name === s.forcedArtifactToolName
            && !s.hasRequiredArtifacts()
          if (boundedForcedArtifactAttempt) {
            // The artifact recovery counter is the hard fuse for these calls.
            // Let all four promised generator attempts reach the executor even
            // when the model reuses identical valid arguments; the generic
            // duplicate-signature guard would otherwise block attempts 3/4 and
            // make the persisted retry budget misleading.
            s.loopGuard.resetRepetition?.()
          }
          const guardDecision = convergenceBlock
            ? { ok: false, result: convergenceBlock, convergenceBlocked: true }
            : s.loopGuard.before(call)
          if (!guardDecision.ok) {
            result = guardDecision.result
            if (!guardDecision.convergenceBlocked) outcomeNoProgressReason = guardDecision.reason
          } else {
            // 每次非思维型工具尝试都计成本，包括模型给出的未知工具/损坏参数。
            // 校验仍会阻止它们真正执行，但不能让无效调用绕过预算。
            if (!isFree) {
              const b = s.budget.consume(1)
              if (!b.ok) {
                outcomeBudgetExceeded = b.reason
                result = { ok: false, code: 'tool_budget_exceeded', error: b.reason, retryable: false }
              }
            }

            if (!result) {
              result = s.redundantImageGenerationGuard(name)
            }

            if (!result) {
              // 被产物门控挡下的文件工具单独给一条可执行的说明,否则模型只看到
              // 「未知工具：create_pptx」会以为是系统故障,继续重试到耗尽预算。
              if (isFileArtifactTool(call.name) && !s.stepArtifactTools.has(call.name)) {
                result = {
                  ok: false,
                  code: 'artifact_tool_not_requested',
                  error: `用户没有要求生成 ${call.name} 这类文件产物,该工具在本次任务中不可用。`,
                  retryable: false,
                  hint: '直接完成用户真正要求的工作(如修改代码、给出结论),并用文字说明结果;不要用文件代替交付。',
                }
              }
            }

            if (!result) {
              result = s.artifactReplacementValidationError(name, args)
                || s.workspaceTargetValidationError(name, args)
            }

            if (!result
              && DYNAMIC_EXECUTION_TOOL_NAMES.has(name)
              && s.capabilityMode === 'execute'
              && s.approvalMode === 'bypass'
              && !s.activeToolSpecs.some((spec) => toolNameFromSpec(spec) === name)) {
              const refreshedSpecs = restoreNamedToolSpecs(
                s.activeToolSpecs,
                s.eligibleFallbackToolSpecs,
                DYNAMIC_EXECUTION_TOOL_NAMES,
              )
              if (refreshedSpecs.some((spec) => toolNameFromSpec(spec) === name)) {
                const previousNames = new Set(s.activeToolSpecs.map(toolNameFromSpec).filter(Boolean))
                s.activeToolSpecs = refreshedSpecs
                for (const spec of s.activeToolSpecs) {
                  const mountedName = toolNameFromSpec(spec)
                  if (DYNAMIC_EXECUTION_TOOL_NAMES.has(mountedName) && !previousNames.has(mountedName)) {
                    s.dynamicallyMountedToolNames.add(mountedName)
                  }
                }
                s.convo = replaceRuntimeCapabilityBlock(s.convo, {
                  toolSpecs: s.activeToolSpecs,
                  approvalMode: s.approvalMode,
                  ...s.outputDirectoryContext,
                })
                s.availableVerificationToolNames = s.activeToolSpecs
                  .map(toolNameFromSpec)
                  .filter((toolName) => VERIFICATION_TOOLS.has(toolName)
                    || isCommandExecutionTool(toolName))
              }
            }

            if (!result) {
              const validationError = validateToolCall(call, s.activeToolSpecs, {
                // 单测/嵌入方可注入自己的 executor；生产默认执行器仍严格限制在已声明工具集。
                allowUnknown: s.executeTool !== executeServerTool,
              })
              if (validationError) result = validationError
            }

            if (!result) {
              result = s.explicitReadOnlyValidationError(name, args)
            }

            if (!result && name === 'request_directory' && s.hasVerifiedDirectoryResolution) {
              result = {
                ok: false,
                code: 'directory_authorization_already_resolved',
                error: 'The requested local directory authorization is already persisted and verified for this turn.',
                retryable: false,
                hint: 'Do not request the directory again. Continue the original task now using the exact authorized path and access mode from the TURN_RESOLUTION system message.',
              }
            }

            if (!result && name === 'request_clarification') {
              result = contradictedCapabilityClarification(args, s.activeToolSpecs, s.convo)
            }

            if (!result && name === 'set_deliverables') {
              try {
                result = s.selectDeliverables(args)
                if (result?.ok !== true && s.deliveryContractReadyForSelection()) {
                  s.deliverableSelectionRetries += 1
                }
              } catch (error) {
                result = normalizeToolError(error)
                if (s.deliveryContractReadyForSelection()) s.deliverableSelectionRetries += 1
              }
            }

            if (!result) {
              try {
                // Resume the exact persisted approval after restart; otherwise
                // run the pre hook once, then create and persist the approval.
                // A resumed approval already contains the hook-rewritten args,
                // so the pre hook must not be fired a second time after restart.
                const resumingApproval = call.checkpointStatus === 'awaiting_approval' && call.checkpointApprovalId
                // Ownerless harness execution is privileged only by possession
                // of the in-process opaque capability. Missing identity alone
                // never grants trust, and serialized input cannot forge it.
                const {
                  hasApprovalSubject,
                  trustedInternalExecution,
                  checkpointPolicyProvenance,
                  checkpointHookAuthorizationProvenance,
                  expectedApprovalContext,
                } = createToolAuthorizationContext({
                  state: s, call, toolName: name, isTrustedInternalLoopPrincipal,
                })
                let effectiveArgs = args
                let gate = null
                let hookAuthorizationProvenance = null
                let hookRequiresApproval = false
                let hookApprovalReason = null
                if (idempotentResume || resumedPreparedSideEffect) {
                  effectiveArgs = call.checkpointExecutionArgs ?? effectiveArgs
                  if (call.checkpointApprovalId) {
                    gate = await resumePersistedApproval({
                      approvalId: call.checkpointApprovalId,
                      signal: s.signal,
                      requireTerminal: true,
                      expectedApprovalContext: expectedApprovalContext(),
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
                  } else {
                    if (trustedInternalExecution) {
                      gate = { proceed: true, args: effectiveArgs, trustedInternal: true }
                    } else if (checkpointHookAuthorizationProvenance) {
                      const restoredHookAuthorization = revalidateHookAuthorization({
                        provenance: checkpointHookAuthorizationProvenance,
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
                      if (!restoredHookAuthorization.proceed) {
                        gate = restoredHookAuthorization
                      } else {
                        const restoredPolicy = revalidateToolPermission({
                          userId: s.job?.userId || null,
                          origin: s.approvalOrigin,
                          toolName: name,
                          args: effectiveArgs,
                          taskGrants: s.job?.sourceType === 'cron' ? s.job.grants : [],
                          expectedPolicyProvenance: checkpointPolicyProvenance,
                          allowAsk: true,
                        })
                        gate = restoredPolicy.proceed
                          ? {
                              ...restoredPolicy,
                              hookAuthorized: true,
                              hookAuthorizationProvenance: restoredHookAuthorization.hookAuthorizationProvenance,
                            }
                          : restoredPolicy
                      }
                    } else {
                      gate = revalidateToolPermission({
                        userId: s.job?.userId || null,
                        origin: s.approvalOrigin,
                        toolName: name,
                        args: effectiveArgs,
                        taskGrants: s.job?.sourceType === 'cron' ? s.job.grants : [],
                        expectedPolicyProvenance: checkpointPolicyProvenance,
                        allowAsk: false,
                      })
                    }
                  }
                  gate = {
                    ...gate,
                    approvalId: call.checkpointApprovalId || null,
                    resumedIdempotentExecution: true,
                  }
                } else if (resumingApproval) {
                  gate = await resumePersistedApproval({
                    approvalId: call.checkpointApprovalId,
                    signal: s.signal,
                    expectedApprovalContext: expectedApprovalContext(),
                  })
                  effectiveArgs = gate.args ?? effectiveArgs
                } else {
                  if (s.enableToolHooks && s.job?.userId) {
                    const preHook = call[TOOL_HOOK_RESULT]
                    if (preHook && !preHook.allow) {
                      result = {
                        ok: false,
                        denied: true,
                        code: 'hook_denied',
                        error: preHook.reason || `pre_tool_use hook denied ${name}`,
                        retryable: false,
                      }
                    } else if (preHook?.replacementArgs && typeof preHook.replacementArgs === 'object') {
                      effectiveArgs = preHook.replacementArgs
                    }
                    // A pre_tool_use hook may authorize the call directly,
                    // bypassing the approval inbox for this invocation.
                    if (preHook?.permissionDecision === 'allow') {
                      hookAuthorizationProvenance = preHook.hookAuthorizationProvenance || null
                    }
                    if (preHook?.permissionDecision === 'ask') {
                      hookRequiresApproval = true
                      hookApprovalReason = preHook.reason || null
                    }
                  }
                  if (!result && effectiveArgs !== args) {
                    const hookValidationError = validateToolCall(
                      { ...call, args: effectiveArgs },
                      s.activeToolSpecs,
                      { allowUnknown: s.executeTool !== executeServerTool },
                    ) || s.explicitReadOnlyValidationError(name, effectiveArgs)
                    if (hookValidationError) result = hookValidationError
                  }
                  if (!result) {
                    gate = trustedInternalExecution
                      ? { proceed: true, args: effectiveArgs, trustedInternal: true }
                      : !hasApprovalSubject
                        ? revalidateToolPermission({
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
                            auditStage('approval_requested', { auditArgs: approval.args ?? effectiveArgs })
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
                }
                if (gate?.proceed && !gate.resumedIdempotentExecution && !trustedInternalExecution) {
                  let verifiedHookAuthorization = false
                  if (gate.hookAuthorized) {
                    const finalHookAuthorization = revalidateHookAuthorization({
                      provenance: gate.hookAuthorizationProvenance,
                      userId: s.job?.userId || null,
                      origin: s.approvalOrigin,
                      jobId: s.approvalOrigin === 'chat' ? null : s.job?.id || null,
                      stepId: s.approvalOrigin === 'chat' ? s.job?.id || null : s.step?.id || null,
                      sessionId: s.approvalSessionId || null,
                      requestId: s.step?.id || null,
                      toolCallId: call.id,
                      toolName: name,
                      args: gate.args ?? effectiveArgs,
                      requireLive: true,
                    })
                    if (!finalHookAuthorization.proceed) {
                      gate = {
                        ...finalHookAuthorization,
                        policyProvenance: gate.policyProvenance,
                      }
                    } else {
                      verifiedHookAuthorization = true
                    }
                  }
                  if (gate.proceed) {
                    const finalPolicy = revalidateToolPermission({
                      userId: s.job?.userId || null,
                      origin: s.approvalOrigin,
                      toolName: name,
                      args: gate.args ?? effectiveArgs,
                      taskGrants: s.job?.sourceType === 'cron' ? s.job.grants : [],
                      expectedPolicyProvenance: Object.hasOwn(gate, 'policyProvenance')
                        ? gate.policyProvenance
                        : null,
                      allowAsk: Boolean(gate.approvalId || verifiedHookAuthorization),
                    })
                    gate = finalPolicy.proceed
                      ? {
                          ...gate,
                          authorization: gate.authorization || finalPolicy.authorization || null,
                          policyProvenance: finalPolicy.policyProvenance,
                        }
                      : { ...finalPolicy, approvalId: gate.approvalId || null }
                  }
                }
                if (gate && !gate.proceed) {
                  result = formatDeniedToolResult(gate)
                  auditTerminalStage = 'denied'
                  auditStage('denied', {
                    auditArgs: gate.args ?? effectiveArgs,
                    auditResult: result,
                    status: 'denied',
                  })
                } else if (gate) {
                  const executionArgs = gate.args ?? effectiveArgs
                  executionArgsUsed = executionArgs
                  auditStage(gate.approvalId ? 'approved' : 'auto_allowed', {
                    auditArgs: executionArgs,
                    auditResult: gate.authorization
                      ? {
                          grantSource: gate.authorization.source || gate.authorization.kind || null,
                          grantKind: gate.authorization.kind || null,
                        }
                      : null,
                  })
                  const finalValidationError = dynamicRegistrationValidationError(executionArgs)
                    || s.redundantImageGenerationGuard(name)
                    || validateToolCall(
                    { ...call, args: executionArgs },
                    s.activeToolSpecs,
                    { allowUnknown: s.executeTool !== executeServerTool },
                  ) || s.explicitReadOnlyValidationError(name, executionArgs)
                    || s.artifactReplacementValidationError(name, executionArgs)
                    || s.workspaceTargetValidationError(name, executionArgs)
                  if (finalValidationError) {
                    result = finalValidationError
                  } else {
                    const execution = await executeAuthorizedTool({
                      state: s, iteration: i, call, toolName: name, executionArgs, gate,
                      durableExecution, checkpointPolicyProvenance,
                      resumedExecutingSideEffect, sideEffectExecution,
                      expectedDynamicRegistrationId,
                      finalAuthorizationCheck: gate.hookAuthorized
                        ? () => revalidateHookAuthorization({
                            provenance: gate.hookAuthorizationProvenance,
                            userId: s.job?.userId || null,
                            origin: s.approvalOrigin,
                            jobId: s.approvalOrigin === 'chat' ? null : s.job?.id || null,
                            stepId: s.approvalOrigin === 'chat' ? s.job?.id || null : s.step?.id || null,
                            sessionId: s.approvalSessionId || null,
                            requestId: s.step?.id || null,
                            toolCallId: call.id,
                            toolName: name,
                            args: executionArgs,
                            requireLive: true,
                          })
                        : null,
                      dependencies: {
                        CHECKPOINT_FLUSH_ERROR_CODE, createToolAbortScope, executeToolWithRetry,
                        getToolMetadata, isLoopPauseResult, isSuccessfulToolResult,
                        normalizeArtifactIdList, rememberApprovedSubagentCall,
                      },
                    })
                    ;({ result, toolExecutionAttempted, artifactId, artifactIds, clarification } = execution)
                  }
                }
                if (gate?.approvalId && !gate.resumedIdempotentExecution && typeof s.onApprovalResolved === 'function') {
                  try {
                    await s.onApprovalResolved(gate)
                  } catch {
                    // Approval has already resolved and the tool may already
                    // have committed an external side effect. An event/UI sink
                    // failure must never overwrite that real outcome and invite
                    // the model to replay the write.
                  }
                }
              } catch (err) {
                if (s.signal?.aborted || err?.name === 'AbortError') throw err
                if (err?.code === CHECKPOINT_FLUSH_ERROR_CODE) throw err
                if (err?.unsafeToReplay === true) throw err
                result = normalizeToolError(err)
              }
            }
          }
        }

        return finalizeToolCallOutcome({
          state: s, call, result, executionArgs: executionArgsUsed,
          toolExecutionAttempted, auditTerminalStage, auditStage, auditOutcomeStatus,
          resumedExecutingSideEffect, sideEffectExecution, runPostTool,
          artifactId, artifactIds, clarification,
          budgetExceeded: outcomeBudgetExceeded,
          noProgressReason: outcomeNoProgressReason,
        })
      }
  return { kind: 'next' }
}
