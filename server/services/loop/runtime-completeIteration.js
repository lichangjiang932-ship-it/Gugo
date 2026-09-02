import { normalizeTurnLocale } from '../../../shared/turnLocale.js'

function terminalCopy(locale) {
  if (normalizeTurnLocale(locale) === 'zh') {
    return {
      clarificationFallback: '需要你补充信息后才能继续。',
      noProgressPrompt: '工具循环因持续无进展而停止。请基于已有信息给出部分结论，不要再调用工具。',
      noProgressFallback: '（工具循环因持续无进展而停止。）',
    }
  }
  return {
    clarificationFallback: 'More information is required before this task can continue.',
    noProgressPrompt: 'The tool loop stopped after making no progress. Use the available information to provide a partial conclusion in English. Do not call any tools.',
    noProgressFallback: '(The tool loop stopped after making no progress.)',
  }
}

export async function completeIteration(s) {
  const i = s.iteration
  const { ARTIFACT_RECOVERY_PHASE_FORCE, DELIVERABLE_SELECTION_FALLBACK_MARKER, MAX_ARTIFACT_DELIVERY_RETRIES, MAX_ARTIFACT_RECOVERY_DIAGNOSTIC_ROUNDS, MAX_DELIVERABLE_SELECTION_RETRIES, mergeCompactionRecovery, writeToolAudit } = s.d
  i.artifactRecoveryExhausted = false
  i.completedArtifactCall = (toolName) => i.toolCalls.some((call) => (
        call.name === toolName
          && call.checkpointStatus === 'completed'
          && call.checkpointResult?.code !== 'tool_execution_superseded_by_steering'
      ))
  i.recoverableArtifactCall = (toolName) => i.toolCalls.some((call) => (
        call.name === toolName
          && call.checkpointStatus === 'completed'
          && call.checkpointResult?.code !== 'tool_execution_superseded_by_steering'
          // A replacement authorization failure is an intentional safety stop,
          // not a malformed generator attempt. Retrying it would repeatedly ask
          // the model to bypass the exact user-authorized artifact target.
          && call.checkpointResult?.code !== 'artifact_replacement_not_authorized'
      ))
  i.recoveryTargetStillMissing = i.artifactRecoveryToolAtIterationStart
        && !s.deliveredArtifactTools.has(i.artifactRecoveryToolAtIterationStart)
  if (!i.batchSupersededBySteering && !s.hasRequiredArtifacts()
        && i.artifactRecoveryToolAtIterationStart
        && i.artifactRecoveryPhaseAtIterationStart
        && i.recoveryTargetStillMissing) {
        const targetAttempted = i.completedArtifactCall(i.artifactRecoveryToolAtIterationStart)
        if (i.artifactRecoveryPhaseAtIterationStart === ARTIFACT_RECOVERY_PHASE_FORCE
          || targetAttempted) {
          // A forced request (including a malformed/wrong-tool response), or a
          // voluntary generator retry during diagnosis, consumes exactly one of
          // the four bounded generation attempts.
          s.forcedArtifactAttemptPending = false
          s.artifactDeliveryRetries += 1
          if (s.artifactDeliveryRetries >= MAX_ARTIFACT_DELIVERY_RETRIES) {
            s.artifactRecoveryIterationLimit = 0
            i.artifactRecoveryExhausted = true
          } else {
            s.scheduleArtifactRecoveryDiagnosis(i.artifactRecoveryToolAtIterationStart)
            s.appendArtifactRecoveryDiagnosisPrompt(i.artifactRecoveryToolAtIterationStart)
          }
          i.noProgressReason = null
          i.noProgressCode = null
        } else {
          // Discovery/input tools completed with their results in `convo`. Give
          // the model at most two full-tool-set rounds so it can list then read,
          // then require the corrected generator call.
          s.artifactRecoveryDiagnosticRounds += 1
          if (s.artifactRecoveryDiagnosticRounds >= MAX_ARTIFACT_RECOVERY_DIAGNOSTIC_ROUNDS) {
            s.appendForcedArtifactPrompt(i.artifactRecoveryToolAtIterationStart)
            s.scheduleForcedArtifactAttempt(i.artifactRecoveryToolAtIterationStart)
          } else {
            s.scheduleArtifactRecoveryDiagnosis(
              i.artifactRecoveryToolAtIterationStart,
              { resetRounds: false },
            )
          }
          i.noProgressReason = null
          i.noProgressCode = null
        }
      } else if (!i.batchSupersededBySteering && !s.hasRequiredArtifacts()
        && !s.artifactRecoveryActive()) {
        // The initial required generator was genuinely executed but failed (or
        // returned no verified artifact). Start recovery even at maxIters.
        const failedExpectedToolName = s.missingArtifactTools().find(i.recoverableArtifactCall)
        if (failedExpectedToolName) {
          s.scheduleArtifactRecoveryDiagnosis(failedExpectedToolName)
          s.appendArtifactRecoveryDiagnosisPrompt(failedExpectedToolName)
          i.noProgressReason = null
          i.noProgressCode = null
        }
      }
  s.checkpointCalls = null
  await s.persistTurn()
  await s.emitToolProgress('batch_completed')
  if (i.batchSupersededBySteering) return { kind: 'continue' }
  if (s.taskVerificationRepairExhausted?.()) {
    const incomplete = await s.finishIncomplete({
      text: s.taskVerificationRepairBlockerText(),
      reason: 'task_verification_repair_exhausted',
      code: 'TASK_VERIFICATION_REPAIR_EXHAUSTED',
      missingRequirements: [
        'verification_failure_repair',
        'conclusive_project_verification',
        'explicit_recovery_retry',
      ],
      retryable: false,
      manualRetryable: true,
      taskVerification: s.taskVerificationRepairDetails?.(),
    })
    if (incomplete.deferredForSteering) return { kind: 'continue' }
    return { kind: 'return', value: incomplete }
  }
  if (i.artifactRecoveryExhausted) {
        const incomplete = await s.finishIncomplete(s.missingArtifactBlocker())
        if (incomplete.deferredForSteering) return { kind: 'continue' }
        return { kind: 'return', value: incomplete }
      }
  if (s.needsDeliverableSelection()
        && s.deliverableSelectionRetries >= MAX_DELIVERABLE_SELECTION_RETRIES) {
        const fallback = s.applySafeDeliverableFallback()
        if (!fallback) {
          const incomplete = await s.finishIncomplete({
            reason: 'deliverable_selection_missing',
            steeringLeaseId: i.steeringLeaseId,
          })
          if (incomplete.deferredForSteering) return { kind: 'continue' }
          return { kind: 'return', value: incomplete }
        }
        s.convo.push({
          role: 'system',
          content: `${DELIVERABLE_SELECTION_FALLBACK_MARKER} The runtime selected only the current turn's verified outputs that satisfy every required generator. Continue with one concise final answer and do not call set_deliverables again unless another artifact is created.`,
        })
        await s.persistTurn()
      }
  const deliverableSelectionPending = s.needsDeliverableSelection()
  const completedDeliverableSelection = !deliverableSelectionPending
    && i.toolCalls.some((call) => (
      call.name === 'set_deliverables'
        && call.checkpointStatus === 'completed'
        && call.checkpointResult?.ok === true
    ))
  // Selection is a protocol step, not the user-facing completion. When it
  // consumes the last dynamically extended recovery iteration, preserve one
  // normal no-tool round so the model can produce an accepted final answer.
  if ((deliverableSelectionPending || completedDeliverableSelection)
    && s.iter + 1 >= s.maxIters) {
    s.maxIters = s.iter + 2
  }
  if (!i.batchSupersededBySteering
        && s.iter + 1 >= s.maxIters
        && s.hasRequiredArtifacts()
        && s.hasRequiredExecutionEvidence()
        && !s.hasPendingMutationVerification()) {
        const boundaryHtmlFailure = await s.validateLocalHtmlDeliveries()
        if (boundaryHtmlFailure) {
          const boundaryRecovery = await s.handleLocalHtmlDeliveryFailure({
            failure: boundaryHtmlFailure,
          })
          if (boundaryRecovery.result) return { kind: 'return', value: boundaryRecovery.result }
          return { kind: 'continue' }
        }
        s.localHtmlDeliveryRetries = 0
      }
  if (i.budgetExceeded) {
        const budgetCopy = s.d.budgetExceededCopy(s.locale, i.budgetExceeded)
        // ★ Lens-4 fix:预算超限写 audit,审计员能追查 job 为什么没跑完
        if (s.job?.userId) {
          writeToolAudit({
            userId: s.job.userId,
            origin: 'budget',
            toolName: 'job_budget',
            args: { jobId: s.job.id, stepId: s.step?.id, snapshot: s.budget.snapshot?.() },
            status: 'denied',
            durationMs: 0,
          })
        }
        // ★ 这里以前直接 return finalText —— 而 finalText 在预算路径上几乎必然是 ''。
        // 用户看到的就是「任务跑了很久,然后一个字都没有」,即
        // 「做到一半就没有后续」最典型的现场。
        //
        // 对齐 maxIters 路径的做法:让模型基于已有信息收个尾。
        // `allowOverBudget` 只放宽调用次数/token，给本轮一次受控收尾机会。
        if (!s.finalText && i.budgetExceededByCompletedModelResponse) {
          s.finalText = budgetCopy.completedModelResponse
        }
        if (!s.finalText) {
          try {
            const wrapUpRequest = await s.callTrackedModel({
              messages: [
                ...s.convo,
                {
                  role: 'system',
                  content: budgetCopy.wrapUpPrompt,
                },
              ],
              tools: [],
              allowOverBudget: true,
              toolChoice: 'none',
            })
            s.recovery = mergeCompactionRecovery(s.recovery, wrapUpRequest.recovery)
            s.finalText = wrapUpRequest.response?.content || ''
          } catch {
            writeToolAudit?.({
              userId: s.job?.userId,
              origin: 'budget',
              toolName: 'wrap_up',
              args: { jobId: s.job?.id, stepId: s.step?.id },
              status: 'error',
              durationMs: 0,
            })
            s.finalText = ''
          }
        }
        const terminal = await s.finishTerminalResult({
          text: !s.hasRequiredArtifacts()
            ? ''
            : s.finalText || budgetCopy.fallbackText,
          artifactIds: s.artifactIds,
          iterations: s.iter + 1,
          incomplete: true,
          budgetExceeded: true,
          reason: i.budgetExceeded,
          recovery: s.recovery,
        }, { steeringLeaseId: i.steeringLeaseId, finalMetadata: { budgetExceeded: true } })
        if (!terminal) return { kind: 'continue' }
        return { kind: 'return', value: terminal }
      }
  if (i.pausedByClarification) {
        // ★ M3: 模型主动调 request_clarification → 当轮 loop 中断交回用户
        const protectedClarification = s.protectClarification(i.pausedByClarification)
        const copy = terminalCopy(s.locale)
        const terminal = await s.finishTerminalResult({
          text: s.finalText || String(
            protectedClarification.question
            || protectedClarification.message
            || copy.clarificationFallback,
          ),
          artifactIds: s.artifactIds,
          iterations: s.iter + 1,
          paused: true,
          clarification: protectedClarification,
          recovery: s.recovery,
        }, {
          steeringLeaseId: i.steeringLeaseId,
          finalMetadata: { paused: true, clarification: protectedClarification },
        })
        if (!terminal) return { kind: 'continue' }
        return { kind: 'return', value: terminal }
      }
  if (i.noProgressReason) {
        const copy = terminalCopy(s.locale)
        try {
          const wrapUpRequest = await s.callTrackedModel({
            messages: [
              ...s.convo,
              {
                role: 'system',
                content: copy.noProgressPrompt,
              },
            ],
            tools: [],
            allowOverBudget: true,
            consumeBudget: (cost) => s.budget.consume(cost),
            toolChoice: 'none',
          })
          s.recovery = mergeCompactionRecovery(s.recovery, wrapUpRequest.recovery)
          const wrapUp = wrapUpRequest.response
          s.finalText = wrapUp?.content || ''
        } catch {
          s.finalText = ''
        }
        const terminal = await s.finishTerminalResult({
          text: !s.hasRequiredArtifacts()
            ? ''
            : s.finalText || copy.noProgressFallback,
          artifactIds: s.artifactIds,
          iterations: s.iter + 1,
          incomplete: true,
          noProgress: true,
          code: i.noProgressCode || 'tool_no_progress',
          retryable: i.noProgressFailure?.retryable === true,
          ...(i.noProgressFailure?.hint ? { hint: i.noProgressFailure.hint } : {}),
          reason: i.noProgressReason,
          recovery: s.recovery,
        }, {
          steeringLeaseId: i.steeringLeaseId,
          finalMetadata: {
              noProgress: true,
              code: i.noProgressCode || 'tool_no_progress',
              retryable: i.noProgressFailure?.retryable === true,
              ...(i.noProgressFailure?.hint ? { hint: i.noProgressFailure.hint } : {}),
            },
        })
        if (!terminal) return { kind: 'continue' }
        return { kind: 'return', value: terminal }
      }
  return { kind: 'next' }
}
