import { localizedTerminalModelText } from './incompleteTerminalPresentation.js'

/**
 * Apply the host-owned terminal gates in their canonical priority order.
 *
 * A non-null return value is already a host-persisted terminal result. Keep
 * this helper separate from max-iteration wrap-up so alternate loop hosts can
 * share the same completion policy without inheriting built-in loop control.
 */
export async function finishUnsatisfiedTerminalGate(s, { steeringLeaseId = null } = {}) {
  if (!s.hasRequiredArtifacts()) {
    return s.finishIncomplete({
      ...s.missingArtifactBlocker(),
      steeringLeaseId,
    })
  }
  if (!s.hasRequiredExecutionEvidence()) {
    return s.finishIncomplete({
      reason: 'execution_evidence_missing',
      steeringLeaseId,
    })
  }
  if (s.taskVerificationRepairExhausted?.()) {
    return s.finishIncomplete({
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
      steeringLeaseId,
    })
  }
  if (s.hasPendingTaskVerificationRepair?.()) {
    return s.finishIncomplete({
      text: s.taskVerificationRepairBlockerText(),
      reason: 'task_verification_repair_pending',
      code: 'TASK_VERIFICATION_REPAIR_PENDING',
      missingRequirements: [
        'conclusive_project_verification',
        'rerun_verification_scope',
      ],
      retryable: true,
      taskVerification: s.taskVerificationRepairDetails?.(),
      steeringLeaseId,
    })
  }
  if (s.hasPendingMutationVerification()) {
    return s.finishIncomplete({
      reason: 'post_mutation_verification_missing',
      steeringLeaseId,
    })
  }
  s.finalLocalHtmlDeliveryFailure = await s.validateLocalHtmlDeliveries()
  if (s.finalLocalHtmlDeliveryFailure) {
    return s.finishIncomplete({
      reason: 'local_html_delivery_validation_failed',
      steeringLeaseId,
    })
  }
  s.localHtmlDeliveryRetries = 0
  if (s.requiresPdfLayoutVerification && !s.pdfLayoutVerificationObserved) {
    return s.finishIncomplete({
      reason: 'pdf_layout_verification_missing',
      steeringLeaseId,
    })
  }
  if (s.needsDeliverableSelection?.()) {
    const fallback = s.applySafeDeliverableFallback?.()
    if (!fallback) {
      return s.finishIncomplete({
        reason: 'deliverable_selection_missing',
        steeringLeaseId,
      })
    }
  }
  return null
}

/** Apply host-owned status and source-handoff filtering to terminal text. */
export function protectTerminalCandidate(s, text, { incomplete = false } = {}) {
  const statusSafeText = typeof s.guardPriorOutcomeStatusText === 'function'
    ? s.guardPriorOutcomeStatusText(text)
    : String(text || '')
  return s.protectTerminalText(statusSafeText, { incomplete })
}

function iterationLimitWrapUpPrompt(locale, maxIterations) {
  const rounds = Math.max(1, Number(maxIterations) || 1)
  return locale === 'en'
    ? `The tool-call limit (${rounds} rounds) has been reached. Summarize the progress so far and what remains based on the available information. Do not call any more tools.`
    : `你已达到工具调用上限（${rounds} 轮）。请基于目前已有的信息总结当前进展和剩余工作，不要再调用任何工具。`
}

export async function finalizeRuntime(s) {
  const { mergeCompactionRecovery, writeToolAudit } = s.d
  // A normal no-tool response can be accepted on the final dynamically
  // extended recovery iteration. In that case processModelResult has already
  // persisted the final checkpoint, so the iteration counter alone must not
  // turn a completed, verified delivery back into an incomplete result.
  const acceptedFinalPersisted = s.finalCheckpointPersisted === true
    && Boolean(String(s.finalText || '').trim())
  const iterationLimitReached = s.iter >= s.maxIters && !acceptedFinalPersisted
  let emptyModelResponse = false
  if (!s.finalText) {
    try {
      const wrapUpRequest = await s.callTrackedModel({
        messages: [
          ...s.convo,
          {
            role: 'system',
            content: iterationLimitWrapUpPrompt(s.locale, s.maxIters),
          },
        ],
        tools: [],
        allowOverBudget: true,
        consumeBudget: (cost) => s.budget.consume(cost),
        toolChoice: 'none',
      })
      s.recovery = mergeCompactionRecovery(s.recovery, wrapUpRequest.recovery)
      const wrapUp = wrapUpRequest.response
      s.finalText = localizedTerminalModelText(s.locale, wrapUp?.content, { strictLocale: true })
    } catch {
      writeToolAudit?.({
        userId: s.job?.userId,
        origin: 'loop',
        toolName: 'wrap_up',
        args: { jobId: s.job?.id, stepId: s.step?.id },
        status: 'error',
        durationMs: 0,
      })
      s.finalText = ''
    }
    if (!s.finalText) {
      emptyModelResponse = !iterationLimitReached
      s.finalText = iterationLimitReached
        ? s.d.formatIncompleteTerminalText('iteration_limit_reached', {
            locale: s.locale,
            maxIterations: s.maxIters,
          })
        : s.d.formatIncompleteTerminalText('empty_model_response', { locale: s.locale })
    }
  }
  const blocked = await finishUnsatisfiedTerminalGate(s)
  if (blocked) return blocked
  s.finalText = protectTerminalCandidate(s, s.finalText, { incomplete: true })
  if (iterationLimitReached) {
    // Every allowed iteration ended with another tool batch. The wrap-up text
    // is useful partial output, but it is not a normal no-tool completion
    // claim and must not be projected as `turn.completed` by the host.
    return s.finishIncomplete({
      text: s.finalText,
      reason: 'iteration_limit_reached',
    })
  }
  if (emptyModelResponse) {
    return s.finishIncomplete({
      text: s.finalText,
      reason: 'empty_model_response',
    })
  }
  if (!s.finalCheckpointPersisted) {
    await s.persistTurn({ final: { text: s.finalText, iterations: Math.min(s.iter + 1, s.maxIters) } })
  }
  return s.emitTurnStopping({
    text: s.finalText,
    artifactIds: s.artifactIds,
    ...s.deliverySelectionFields(),
    iterations: Math.min(s.iter + 1, s.maxIters),
    recovery: s.recovery,
  })
}
