import { assertRuntimeStage } from './runtimeContract.js'

export async function executeToolCalls(s) {
  assertRuntimeStage(s, 'execute-tool-calls')
  const i = s.iteration
  const { CHECKPOINT_FLUSH_ERROR_CODE, DYNAMIC_EXECUTION_TOOL_NAMES, FAILURE_RECOVERY_MARKER, FAILURE_RECOVERY_THRESHOLD, TOOL_HOOK_RESULT, VERIFICATION_TOOLS, contradictedCapabilityClarification, createToolAbortScope, executeServerTool, executeToolWithRetry, formatDeniedToolResult, getToolMetadata, isCommandExecutionTool, isFileArtifactTool, isLoopPauseResult, isSubstantiveToolCall, isSuccessfulToolResult, normalizeArtifactIdList, normalizeToolError, rememberApprovedSubagentCall, replaceRuntimeCapabilityBlock, restoreFailureRecovery, restoreNamedToolSpecs, resumePersistedApproval, revalidateToolPermission, runPostTool, runPreTool, shouldReflectOnFailure, supportsIdempotentResume, toolNameFromSpec, validateToolCall, writeToolAudit } = s.d
  i.pausedByClarification = null
  i.budgetExceededByCompletedModelResponse = s.modelBudgetExceededAfterResponse
  s.modelBudgetExceededAfterResponse = null
  i.budgetExceeded = i.budgetExceededByCompletedModelResponse
  i.noProgressReason = null
  i.noProgressCode = null
  i.markCall = async (call, updates) => {
        Object.assign(call, updates)
        await s.persistTurn()
      }
  i.observeFailureRecovery = (call, result) => {
        if (isSuccessfulToolResult(result)) {
          if (isSubstantiveToolCall(call)) {
            s.failureRecovery = restoreFailureRecovery()
            s.pendingFailureRecoveryPrompt = false
          }
          return
        }
        if (!shouldReflectOnFailure(result)) return
        const tool = String(call?.name || '').trim()
        if (!tool) return
        if (s.failureRecovery.tool !== tool) {
          s.failureRecovery = { tool, count: 0, reflected: false, attempts: [] }
        }
        s.failureRecovery.count += 1
        s.failureRecovery.attempts.push({
          tool,
          code: String(result?.code || 'tool_execution_failed').slice(0, 160),
          message: [
            String(result?.error || 'Tool execution failed.'),
            result?.hint ? `Hint: ${String(result.hint)}` : '',
          ].filter(Boolean).join(' ').slice(0, 800),
        })
        s.failureRecovery.attempts = s.failureRecovery.attempts.slice(-FAILURE_RECOVERY_THRESHOLD)
        if (s.failureRecovery.count >= FAILURE_RECOVERY_THRESHOLD && !s.failureRecovery.reflected) {
          s.pendingFailureRecoveryPrompt = true
        }
      }
  i.appendFailureRecoveryPrompt = () => {
        if (!s.pendingFailureRecoveryPrompt || s.failureRecovery.reflected) return false
        const tried = s.failureRecovery.attempts.map((attempt, index) => (
          `${index + 1}. ${attempt.tool} failed with ${attempt.code}: ${attempt.message}`
        ))
        s.convo.push({
          role: 'system',
          content: [
            FAILURE_RECOVERY_MARKER,
            `The same tool (${s.failureRecovery.tool}) has failed ${s.failureRecovery.count} consecutive times.`,
            'Analyze the failure before making another call. Do not repeat the same method or merely vary guessed arguments.',
            'State internally what was tried, identify the likely cause from the concrete errors below, then choose a materially different strategy or report one specific blocker.',
            ...(process.platform === 'win32'
              && isCommandExecutionTool(s.failureRecovery.tool)
              && s.activeToolSpecs.some((spec) => toolNameFromSpec(spec) === 'write_file')
              ? [`For long or multiline Python on Windows, the required different strategy is: create a UTF-8 .py file with write_file, run it with ${s.failureRecovery.tool}, then verify the declared final outputs. Do not retry another long python -c command or a Unix-only pipeline.`]
              : []),
            ...tried,
          ].join('\n'),
        })
        s.failureRecovery.reflected = true
        s.pendingFailureRecoveryPrompt = false
        return true
      }
  i.executeOne = async (call, { durableExecution = true } = {}) => {
        if (s.signal?.aborted) {
          const error = new Error('Turn cancelled')
          error.name = 'AbortError'
          throw error
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
        const auditStartedAt = Date.now()
        let auditTerminalStage = null
        let toolExecutionAttempted = false
        const auditStage = (stage, {
          auditArgs = args,
          auditResult = null,
          status = 'ok',
        } = {}) => {
          if (!s.job?.userId) return
          writeToolAudit({
            userId: s.job.userId,
            origin: s.approvalOrigin,
            toolName: name,
            callId: call.id,
            stage,
            args: auditArgs,
            result: auditResult,
            status,
            durationMs: ['finished', 'filtered', 'denied'].includes(stage)
              ? Math.max(0, Date.now() - auditStartedAt)
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
        const checkpointExecutionArgs = call.checkpointExecutionArgs ?? args
        const idempotentResume = call.checkpointStatus === 'executing'
          && supportsIdempotentResume(s.executeTool, {
            name,
            args: checkpointExecutionArgs,
            job: s.job,
            step: s.step,
            toolCallId: call.id,
            idempotencyKey: call.idempotencyKey,
          })
        const readOnlyResumeValidationError = call.checkpointStatus === 'executing'
          ? s.explicitReadOnlyValidationError(name, checkpointExecutionArgs)
          : null
        const configuredToolValidationError = s.disabledToolValidationError(name)
        if (configuredToolValidationError) {
          // The schema remains visible by design, but the execution switch is
          // authoritative for fresh calls, awaiting approvals and executing
          // checkpoints alike. Run this before hooks/approval/idempotent resume.
          result = configuredToolValidationError
        } else if (readOnlyResumeValidationError) {
          result = readOnlyResumeValidationError
        } else if (call.modelOutputTruncated) {
          result = {
            ok: false,
            code: 'tool_call_truncated',
            error: 'The model reached its output-token limit while generating this tool-call batch, so the arguments may be incomplete and were not executed.',
            retryable: true,
            hint: 'Generate a fresh complete tool call. Shorten large inline content or split the work into smaller calls when necessary.',
          }
        } else if (call.checkpointStatus === 'executing'
          && getToolMetadata(name, {
            args: checkpointExecutionArgs,
            userId: s.job?.userId || null,
          }).isReadOnly !== true
          && !idempotentResume) {
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
                let effectiveArgs = args
                let gate = null
                let hookAuthorizedCall = false
                let hookRequiresApproval = false
                let hookApprovalReason = null
                if (idempotentResume) {
                  effectiveArgs = call.checkpointExecutionArgs ?? effectiveArgs
                  gate = {
                    ...revalidateToolPermission({
                      userId: s.job?.userId || null,
                      origin: s.approvalOrigin,
                      toolName: name,
                      args: effectiveArgs,
                    }),
                    approvalId: call.checkpointApprovalId || null,
                    resumedIdempotentExecution: true,
                  }
                } else if (resumingApproval) {
                  gate = await resumePersistedApproval({ approvalId: call.checkpointApprovalId, signal: s.signal })
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
                    if (preHook?.permissionDecision === 'allow') hookAuthorizedCall = true
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
                    gate = await s.requestToolApproval({
                      userId: s.job?.userId || null,
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
                      preAuthorized: hookAuthorizedCall,
                      onPending: async (approval) => {
                        auditStage('approval_requested', { auditArgs: approval.args ?? effectiveArgs })
                        await i.markCall(call, {
                          checkpointStatus: 'awaiting_approval',
                          checkpointApprovalId: approval.id,
                        })
                        if (typeof s.onApprovalPending === 'function') await s.onApprovalPending(approval)
                      },
                    })
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
                  })
                  const finalValidationError = s.redundantImageGenerationGuard(name)
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
                    rememberApprovedSubagentCall(s.subagentApprovalContext, name, executionArgs, gate)
                    const executionMetadata = getToolMetadata(name, {
                      args: executionArgs,
                      userId: s.job?.userId || null,
                    })
                    // Mutating tools ignore lease/transport aborts while a call is in flight,
                    // but an explicit user stop still reaches cancellable shell/browser work.
                    const abortScope = createToolAbortScope(s.signal, executionMetadata.interruptBehavior)
                    if (durableExecution) {
                      await i.markCall(call, {
                        checkpointStatus: 'executing',
                        checkpointApprovalId: gate.approvalId || call.checkpointApprovalId || null,
                        checkpointExecutionArgs: executionArgs,
                        idempotencyKey: call.idempotencyKey,
                      })
                    }
                    try {
                      toolExecutionAttempted = true
                      let checkpointFailure = null
                      result = await executeToolWithRetry({
                        metadata: executionMetadata,
                        signal: abortScope.signal,
                        maxAttempts: s.toolRetryMaxAttempts,
                        baseDelayMs: s.toolRetryBaseDelayMs,
                        execute: async ({ attempt } = {}) => {
                          try {
                            await s.checkpointBarrier.beforeSideEffect({
                              meta: {
                                boundary: 'tool-execution',
                                iteration: s.iter,
                                attempt: Number(attempt) || 1,
                                toolName: name,
                                toolCallId: call.id,
                              },
                            })
                            checkpointFailure = null
                          } catch (error) {
                            checkpointFailure = error
                            throw error
                          }
                          return s.executeTool({
                            name,
                            args: executionArgs,
                            job: s.activeArtifactOutputPrompt
                              ? { ...s.job, userPrompt: s.activeArtifactOutputPrompt }
                              : s.job,
                            step: s.step,
                            signal: abortScope.signal,
                            budget: s.budget,
                            skillId: s.explicitSkillId || null,
                            toolCallId: call.id,
                            idempotencyKey: call.idempotencyKey,
                            approvalContext: s.subagentApprovalContext,
                            allowedArtifactTools: s.stepArtifactTools,
                            requiresLocalArtifactDelivery: s.requiresLocalArtifactDelivery,
                          })
                        },
                      })
                      if (checkpointFailure) throw checkpointFailure
                    } finally {
                      abortScope.dispose()
                    }
                    if (gate.authorization && result && typeof result === 'object') {
                      result = { ...result, approvalAuthorization: gate.authorization }
                    }
                    artifactId = result?.artifactId || null
                    artifactIds = normalizeArtifactIdList(result?.artifactIds)
                    if (artifactIds.length === 0 && artifactId) artifactIds = [String(artifactId)]
                    if (isLoopPauseResult(result)) clarification = result.clarification
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
                result = normalizeToolError(err)
              }
            }
          }
        }

        try {
          await runPostTool({
            loopEvents: s.activeLoopEvents,
            call: { ...call, args: executionArgsUsed },
            result,
            context: s.loopEventContext({
              phase: 'post-tool',
              executed: toolExecutionAttempted,
            }),
          })
        } catch {
          // The outcome is final. Observer failures must not cause a replay.
        }

        if (toolExecutionAttempted) {
          auditStage('finished', {
            auditArgs: executionArgsUsed,
            auditResult: result,
            status: auditOutcomeStatus(result),
          })
        } else if (!auditTerminalStage) {
          auditStage('filtered', {
            auditArgs: executionArgsUsed,
            auditResult: result,
            status: auditOutcomeStatus(result),
          })
        }

        return {
          call,
          executionArgs: executionArgsUsed,
          result,
          artifactId,
          artifactIds,
          clarification,
          budgetExceeded: outcomeBudgetExceeded,
          noProgressReason: outcomeNoProgressReason,
        }
      }
  return { kind: 'next' }
}
