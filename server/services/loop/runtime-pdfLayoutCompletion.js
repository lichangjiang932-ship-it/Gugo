import { isTrustedPdfLayoutReceipt } from '../../utils/pdfLayoutReceipt.js'
import { normalizeMutationTarget, targetsMatch } from './heuristics/mutationClassification.js'

function binding(s) {
  return {
    userId: s.executionScope?.userId || s.job?.userId || null,
    sessionId: s.executionScope?.sessionId || s.job?.sessionId || null,
    executionId: s.executionScope?.jobId || s.job?.id || null,
    projectDirectory: s.executionScope?.projectDirectory || s.verificationProjectDirectory || null,
    sectionLabel: s.d.requestedPdfSectionLabel(s.executionIntentText),
  }
}

function recompute(s) {
  s.pdfLayoutVerificationObserved = s.pdfLayoutTargets.size > 0
    && [...s.pdfLayoutTargets].every((target) => [...s.pdfLayoutReceipts.values()].some((receipt) => (
      targetsMatch(receipt.output.path, target, s.executionScope)
    )))
}

export function initializePdfLayoutCompletion(s) {
  s.pdfLayoutTargets = new Set((s.restoredState?.completionGuards?.pdfLayoutTargets || [])
    .map(normalizeMutationTarget).filter((value) => /\.pdf$/iu.test(value)))
  const expected = binding(s)
  s.pdfLayoutReceipts = new Map((s.restoredState?.completionGuards?.pdfLayoutReceipts || [])
    .filter((receipt) => isTrustedPdfLayoutReceipt(receipt, expected)
      && (!expected.sectionLabel || receipt.sectionLabel === expected.sectionLabel))
    .map((receipt) => [receipt.output.path, receipt]))
  // Legacy booleans and cold-process signatures are never promoted to proof.
  recompute(s)
}

export function recordPdfLayoutMutation(s, targets) {
  const files = [...targets].map(normalizeMutationTarget).filter((value) => /\.pdf$/iu.test(value))
  if (!files.length) return
  for (const file of files) s.pdfLayoutTargets.add(file)
  s.pdfLayoutReceipts.clear()
  s.pdfLayoutVerificationObserved = false
}

export function recordPdfLayoutReceipt(s, call, result) {
  if (!s.d.isSuccessfulPdfLayoutVerification(call, result, {
    ...binding(s), targets: [...s.pdfLayoutTargets],
  })) return false
  const receipt = result.pdfLayoutVerification
  if (s.pdfLayoutTargets.size === 0) s.pdfLayoutTargets.add(receipt.output.path)
  s.pdfLayoutReceipts.set(receipt.output.path, receipt)
  recompute(s)
  return s.pdfLayoutVerificationObserved
}
