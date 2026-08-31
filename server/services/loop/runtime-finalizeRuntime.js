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
      text: '\u4efb\u52a1\u5c1a\u672a\u5b8c\u6210\uff1a\u5c1a\u672a\u53d6\u5f97\u7b26\u5408\u672c\u6b21\u4fee\u6539\u76ee\u6807\u7684\u5b9e\u9645\u6267\u884c\u8bc1\u636e\u3002\u53ef\u91cd\u8bd5\u672c\u4efb\u52a1\uff0c\u6216\u5207\u6362\u5230\u652f\u6301\u5de5\u5177\u8c03\u7528\u7684\u6a21\u578b\u3002',
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
      text: s.availableVerificationToolNames.length > 0
        ? '修改已成功写入并保留，可在文件栏查看；但尚未通过读回、差异检查或项目检查，因此仍标记为待验证。'
        : '修改已成功写入并保留，可在文件栏查看；当前没有可用的验证工具，因此仍无法确认验证通过。',
      reason: 'post_mutation_verification_missing',
      steeringLeaseId,
    })
  }
  s.finalLocalHtmlDeliveryFailure = await s.validateLocalHtmlDeliveries()
  if (s.finalLocalHtmlDeliveryFailure) {
    return s.finishIncomplete({
      text: '网页修改已成功写入并保留，可在文件栏查看；资源完整性验证尚未通过，因此仍标记为待验证。请重试以继续自动修复。',
      reason: 'local_html_delivery_validation_failed',
      steeringLeaseId,
    })
  }
  s.localHtmlDeliveryRetries = 0
  if (s.requiresPdfLayoutVerification && !s.pdfLayoutVerificationObserved) {
    return s.finishIncomplete({
      text: '\u6587\u4ef6\u5df2\u751f\u6210\uff0c\u4f46\u5c1a\u672a\u901a\u8fc7\u76ee\u6807\u9875\u3001\u975e\u76ee\u6807\u9875\u3001\u6587\u672c\u8fb9\u754c\u4e0e\u9010\u9875\u6e32\u67d3\u7684 PDF \u5e03\u5c40\u6821\u9a8c\uff0c\u56e0\u6b64\u6ca1\u6709\u6807\u8bb0\u4e3a\u5b8c\u6210\u3002',
      reason: 'pdf_layout_verification_missing',
      steeringLeaseId,
    })
  }
  if (s.needsDeliverableSelection?.()) {
    const fallback = s.applySafeDeliverableFallback?.()
    if (!fallback) {
      return s.finishIncomplete({
        text: 'Files were created, but final deliverable selection did not converge. No unverified or intermediate files were attached to the answer.',
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
            content: `你已达到工具调用上限(${s.maxIters} 轮)。请基于目前已有的信息给出最终回答,不要再调用任何工具。`,
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
        ? `已达到 ${s.maxIters} 轮工具调用上限，任务尚未完成。请重试以继续。`
        : '模型未返回可显示内容，本次任务未完成。请重试，或检查当前模型配置。'
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
