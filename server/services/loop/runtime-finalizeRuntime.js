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
          ? '\u4fee\u6539\u5df2\u7ecf\u6267\u884c\uff0c\u4f46\u5c1a\u672a\u901a\u8fc7\u8bfb\u56de\u3001\u5dee\u5f02\u68c0\u67e5\u6216\u9879\u76ee\u68c0\u67e5\u9a8c\u8bc1\uff0c\u56e0\u6b64\u6ca1\u6709\u6807\u8bb0\u4e3a\u5b8c\u6210\u3002'
          : '\u4fee\u6539\u5df2\u7ecf\u6267\u884c\uff0c\u4f46\u5f53\u524d\u6ca1\u6709\u53ef\u7528\u7684\u9a8c\u8bc1\u5de5\u5177\uff0c\u56e0\u6b64\u65e0\u6cd5\u786e\u8ba4\u5b8c\u6210\u3002',
        reason: 'post_mutation_verification_missing',
      })
    }
  s.finalLocalHtmlDeliveryFailure = await s.validateLocalHtmlDeliveries()
  if (s.finalLocalHtmlDeliveryFailure) {
      return s.finishIncomplete({
        text: '网页文件尚未通过资源完整性验证，因此没有作为已完成文件显示或交付。请重试以继续自动修复。',
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
