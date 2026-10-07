import { recordPdfLayoutReceipt } from './runtime-pdfLayoutCompletion.js'

export function recordVerificationObservations(s, outcome, executedCall, succeeded) {
  const { normalizeMutationTarget, targetsMatch } = s.d
  const observation = s.observeTaskVerificationRepair(executedCall, outcome.result)
  if (observation.changed && !observation.failed && !observation.indeterminate) {
    s.loopGuard.markProgress?.()
    s.mutationVerificationRetries = 0
  }
  if (observation.failed || observation.indeterminate) {
    const prompt = s.taskVerificationRepairPrompt()
    if (prompt) s.iteration.deferredPostBatchMessages.push({ role: 'system', content: prompt })
  }
  if (succeeded && executedCall?.name === 'read_file'
    && typeof outcome.result?.content === 'string' && outcome.result?.truncated !== true) {
    const targets = [outcome.result?.path, executedCall?.args?.path]
      .map(normalizeMutationTarget).filter(Boolean)
    for (const htmlTarget of s.localHtmlDeliveryTargets) {
      if (targets.some((candidate) => targetsMatch(candidate, htmlTarget, s.executionScope))) {
        s.localHtmlReadSources.set(htmlTarget, outcome.result.content)
      }
    }
  }
  if (s.requiresPdfLayoutVerification
    && recordPdfLayoutReceipt(s, executedCall, outcome.result)) {
    s.pdfLayoutVerificationRetries = 0
  }
}
