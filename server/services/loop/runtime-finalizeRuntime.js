export async function finalizeRuntime(s) {
  const { mergeCompactionRecovery, writeToolAudit } = s.d
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
        s.finalText = `已达到 ${s.maxIters} 轮工具调用上限，任务尚未完成。请重试以继续。`
      }
    }
  s.finalText = s.protectTerminalText(s.guardPriorOutcomeStatusText(s.finalText), { incomplete: true })
  if (!s.hasRequiredArtifacts()) {
      return s.finishIncomplete({
        text: s.missingArtifactBlockerText(),
        reason: 'artifact_delivery_not_converged',
      })
    }
  if (!s.hasRequiredExecutionEvidence()) {
      return s.finishIncomplete({
        text: '\u4efb\u52a1\u5c1a\u672a\u5b8c\u6210\uff1a\u5c1a\u672a\u53d6\u5f97\u7b26\u5408\u672c\u6b21\u4fee\u6539\u76ee\u6807\u7684\u5b9e\u9645\u6267\u884c\u8bc1\u636e\u3002\u53ef\u91cd\u8bd5\u672c\u4efb\u52a1\uff0c\u6216\u5207\u6362\u5230\u652f\u6301\u5de5\u5177\u8c03\u7528\u7684\u6a21\u578b\u3002',
        reason: 'execution_evidence_missing',
      })
    }
  if (s.hasPendingMutationVerification()) {
      return s.finishIncomplete({
        text: s.availableVerificationToolNames.length > 0
          ? '修改已成功写入并保留，可在文件栏查看；但尚未通过读回、差异检查或项目检查，因此仍标记为待验证。'
          : '修改已成功写入并保留，可在文件栏查看；当前没有可用的验证工具，因此仍无法确认验证通过。',
        reason: 'post_mutation_verification_missing',
      })
    }
  s.finalLocalHtmlDeliveryFailure = await s.validateLocalHtmlDeliveries()
  if (s.finalLocalHtmlDeliveryFailure) {
      return s.finishIncomplete({
        text: '网页修改已成功写入并保留，可在文件栏查看；资源完整性验证尚未通过，因此仍标记为待验证。请重试以继续自动修复。',
        reason: 'local_html_delivery_validation_failed',
      })
    }
  s.localHtmlDeliveryRetries = 0
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
