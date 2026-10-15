import { recordPdfLayoutReceipt } from './runtime-pdfLayoutCompletion.js'
import { consumeVerificationObservation } from './verificationObservationConsumer.js'

export function recordVerificationObservations(s, outcome, executedCall, succeeded) {
  consumeVerificationObservation(Object.freeze({ call: executedCall, result: outcome.result, succeeded,
    htmlTargets: Object.freeze([...s.localHtmlDeliveryTargets]), executionScope: s.executionScope }), Object.freeze({
    observe: s.observeTaskVerificationRepair, repairPrompt: s.taskVerificationRepairPrompt,
    normalizeTarget: s.d.normalizeMutationTarget, targetsMatch: s.d.targetsMatch,
  }), Object.freeze({
    markProgress: () => s.loopGuard.markProgress?.(),
    resetRetries: () => { s.mutationVerificationRetries = 0 },
    appendMessage: message => s.iteration.deferredPostBatchMessages.push(message),
    retainHtml: (path, content) => s.localHtmlReadSources.set(path, content),
  }))
  if (s.requiresPdfLayoutVerification
    && recordPdfLayoutReceipt(s, executedCall, outcome.result)) {
    s.pdfLayoutVerificationRetries = 0
  }
}
