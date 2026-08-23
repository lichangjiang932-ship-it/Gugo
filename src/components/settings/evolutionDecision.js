export function buildEvolutionDecisionInput(review, decision, reasonValue) {
  const reason = String(reasonValue || '').trim()
  if (!review || !reason) return null
  return {
    evaluationId: review.evaluationId,
    decision,
    reason,
    confirmations: {
      candidateContentSha256: review.confirmations.candidateContentSha256,
      replayRunFingerprint: review.confirmations.replayRunFingerprint,
      evaluationFingerprint: review.confirmations.evaluationFingerprint,
      rollbackBaselineSha256: review.confirmations.rollbackBaselineSha256,
    },
  }
}
