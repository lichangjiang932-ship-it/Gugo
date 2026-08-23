/**
 * Project the last physical Provider attempt into the manual-recovery DTO.
 *
 * Keep this as an explicit allowlist. Physical-attempt checkpoints also carry
 * endpoint/configuration fingerprints and Provider capability provenance;
 * those fields are recovery guards, not browser-facing diagnostics.
 */
export function lastModelProviderAttemptForClient(invocation) {
  const attempts = Array.isArray(invocation?.providerAttempts)
    ? invocation.providerAttempts
    : []
  const attempt = attempts.at(-1)
  if (!attempt) return null

  const sequence = Number(attempt.sequence)
  const providerAttempt = Number(attempt.providerAttempt)
  const failoverIndex = Number(attempt.failoverIndex)
  const providerId = String(attempt.providerId || '').trim()
  const modelName = String(attempt.modelName || '').trim()
  const providerKind = String(attempt.providerKind || '').trim()
  if (!Number.isSafeInteger(sequence) || sequence < 1
    || !Number.isSafeInteger(providerAttempt) || providerAttempt < 1
    || !Number.isSafeInteger(failoverIndex) || failoverIndex < 0
    || !providerId || !modelName || !providerKind) {
    return null
  }

  return {
    sequence,
    providerAttempt,
    failoverIndex,
    providerId,
    modelName,
    providerKind,
  }
}
