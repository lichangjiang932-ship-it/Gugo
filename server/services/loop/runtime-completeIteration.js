import { normalizeTurnLocale } from '../../../shared/turnLocale.js'
import { localizedTerminalModelText } from './incompleteTerminalPresentation.js'

const HAN_TEXT = /[\u3400-\u9fff]/u

function terminalCopy(locale) {
  if (normalizeTurnLocale(locale) === 'zh') {
    return {
      clarificationFallback: '需要你补充信息后才能继续。',
      noProgressPrompt: '工具循环因持续无进展而停止。请基于已有信息给出部分结论，不要再调用工具。',
      noProgressFallback: '（工具循环因持续无进展而停止。）',
      noProgressHint: '请停止重复调用，改用已有结果收尾或换一种方法。',
    }
  }
  return {
    clarificationFallback: 'More information is required before this task can continue.',
    noProgressPrompt: 'The tool loop stopped after making no progress. Use the available information to provide a partial conclusion in English. Do not call any tools.',
    noProgressFallback: '(The tool loop stopped after making no progress.)',
    noProgressHint: 'Stop repeating the same tool call. Use the available results to finish, or try a different approach.',
  }
}

function localizedNoProgressHint(locale, hint, fallback) {
  const value = String(hint || '').trim()
  if (!value) return ''
  return normalizeTurnLocale(locale) === 'zh'
    ? (HAN_TEXT.test(value) ? value : fallback)
    : (localizedTerminalModelText(locale, value) || fallback)
}

function updateArtifactRecovery(s) {
  const i = s.iteration
  const {
    ARTIFACT_RECOVERY_PHASE_FORCE,
    MAX_ARTIFACT_DELIVERY_RETRIES,
    MAX_ARTIFACT_RECOVERY_DIAGNOSTIC_ROUNDS,
  } = s.d
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
      && call.checkpointResult?.code !== 'artifact_replacement_not_authorized'
  ))
  i.recoveryTargetStillMissing = i.artifactRecoveryToolAtIterationStart
    && !s.deliveredArtifactTools.has(i.artifactRecoveryToolAtIterationStart)
  if (!i.batchSupersededBySteering
    && !s.hasRequiredArtifacts()
    && i.artifactRecoveryToolAtIterationStart
    && i.artifactRecoveryPhaseAtIterationStart
    && i.recoveryTargetStillMissing) {
    const targetAttempted = i.completedArtifactCall(i.artifactRecoveryToolAtIterationStart)
    if (i.artifactRecoveryPhaseAtIterationStart === ARTIFACT_RECOVERY_PHASE_FORCE
      || targetAttempted) {
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
  } else if (!i.batchSupersededBySteering
    && !s.hasRequiredArtifacts()
    && !s.artifactRecoveryActive()) {
    const failedExpectedToolName = s.missingArtifactTools().find(i.recoverableArtifactCall)
    if (failedExpectedToolName) {
      s.scheduleArtifactRecoveryDiagnosis(failedExpectedToolName)
      s.appendArtifactRecoveryDiagnosisPrompt(failedExpectedToolName)
      i.noProgressReason = null
      i.noProgressCode = null
    }
  }
}

async function applyIterationCompletionGuards(s) {
  const i = s.iteration
  const { DELIVERABLE_SELECTION_FALLBACK_MARKER, MAX_DELIVERABLE_SELECTION_RETRIES } = s.d
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
    return incomplete.deferredForSteering
      ? { kind: 'continue' }
      : { kind: 'return', value: incomplete }
  }
  if (i.artifactRecoveryExhausted) {
    const incomplete = await s.finishIncomplete(s.missingArtifactBlocker())
    return incomplete.deferredForSteering
      ? { kind: 'continue' }
      : { kind: 'return', value: incomplete }
  }
  if (s.needsDeliverableSelection()
    && s.deliverableSelectionRetries >= MAX_DELIVERABLE_SELECTION_RETRIES) {
    const fallback = s.applySafeDeliverableFallback()
    if (!fallback) {
      const incomplete = await s.finishIncomplete({
        reason: 'deliverable_selection_missing',
        steeringLeaseId: i.steeringLeaseId,
      })
      return incomplete.deferredForSteering
        ? { kind: 'continue' }
        : { kind: 'return', value: incomplete }
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
      const recovery = await s.handleLocalHtmlDeliveryFailure({ failure: boundaryHtmlFailure })
      return recovery.result
        ? { kind: 'return', value: recovery.result }
        : { kind: 'continue' }
    }
    s.localHtmlDeliveryRetries = 0
  }
  return null
}

async function finishBudgetExceeded(s) {
  const i = s.iteration
  const { budgetExceededCopy, mergeCompactionRecovery, writeToolAudit } = s.d
  const budgetCopy = budgetExceededCopy(s.locale, i.budgetExceeded)
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
  if (!s.finalText && i.budgetExceededByCompletedModelResponse) {
    s.finalText = budgetCopy.completedModelResponse
  }
  if (!s.finalText) {
    try {
      const wrapUpRequest = await s.callTrackedModel({
        messages: [...s.convo, { role: 'system', content: budgetCopy.wrapUpPrompt }],
        tools: [],
        allowOverBudget: true,
        toolChoice: 'none',
      })
      s.recovery = mergeCompactionRecovery(s.recovery, wrapUpRequest.recovery)
      s.finalText = localizedTerminalModelText(
        s.locale,
        wrapUpRequest.response?.content,
        { strictLocale: true },
      )
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
    text: !s.hasRequiredArtifacts() ? '' : s.finalText || budgetCopy.fallbackText,
    artifactIds: s.artifactIds,
    iterations: s.iter + 1,
    incomplete: true,
    budgetExceeded: true,
    reason: i.budgetExceeded,
    recovery: s.recovery,
  }, { steeringLeaseId: i.steeringLeaseId, finalMetadata: { budgetExceeded: true } })
  return terminal ? { kind: 'return', value: terminal } : { kind: 'continue' }
}

async function finishClarification(s) {
  const i = s.iteration
  const clarification = s.protectClarification(i.pausedByClarification)
  const copy = terminalCopy(s.locale)
  const terminal = await s.finishTerminalResult({
    text: s.finalText || String(
      clarification.question || clarification.message || copy.clarificationFallback,
    ),
    artifactIds: s.artifactIds,
    iterations: s.iter + 1,
    paused: true,
    clarification,
    recovery: s.recovery,
  }, {
    steeringLeaseId: i.steeringLeaseId,
    finalMetadata: { paused: true, clarification },
  })
  return terminal ? { kind: 'return', value: terminal } : { kind: 'continue' }
}

async function finishNoProgress(s) {
  const i = s.iteration
  const { mergeCompactionRecovery } = s.d
  const copy = terminalCopy(s.locale)
  const noProgressHint = localizedNoProgressHint(
    s.locale,
    i.noProgressFailure?.hint,
    copy.noProgressHint,
  )
  try {
    const wrapUpRequest = await s.callTrackedModel({
      messages: [...s.convo, { role: 'system', content: copy.noProgressPrompt }],
      tools: [],
      allowOverBudget: true,
      consumeBudget: (cost) => s.budget.consume(cost),
      toolChoice: 'none',
    })
    s.recovery = mergeCompactionRecovery(s.recovery, wrapUpRequest.recovery)
    s.finalText = localizedTerminalModelText(
      s.locale,
      wrapUpRequest.response?.content,
      { strictLocale: true },
    )
  } catch {
    s.finalText = ''
  }
  const terminal = await s.finishTerminalResult({
    text: !s.hasRequiredArtifacts() ? '' : s.finalText || copy.noProgressFallback,
    artifactIds: s.artifactIds,
    iterations: s.iter + 1,
    incomplete: true,
    noProgress: true,
    code: i.noProgressCode || 'tool_no_progress',
    retryable: i.noProgressFailure?.retryable === true,
    ...(noProgressHint ? { hint: noProgressHint } : {}),
    reason: i.noProgressReason,
    recovery: s.recovery,
  }, {
    steeringLeaseId: i.steeringLeaseId,
    finalMetadata: {
      noProgress: true,
      code: i.noProgressCode || 'tool_no_progress',
      retryable: i.noProgressFailure?.retryable === true,
      ...(noProgressHint ? { hint: noProgressHint } : {}),
    },
  })
  return terminal ? { kind: 'return', value: terminal } : { kind: 'continue' }
}

export async function completeIteration(s) {
  const i = s.iteration
  updateArtifactRecovery(s)
  s.checkpointCalls = null
  await s.persistTurn()
  await s.emitToolProgress('batch_completed')
  if (i.batchSupersededBySteering) return { kind: 'continue' }
  const guardOutcome = await applyIterationCompletionGuards(s)
  if (guardOutcome) return guardOutcome
  if (i.budgetExceeded) return finishBudgetExceeded(s)
  if (i.pausedByClarification) return finishClarification(s)
  if (i.noProgressReason) return finishNoProgress(s)
  return { kind: 'next' }
}
