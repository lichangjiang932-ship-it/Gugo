import {
  normalizeArtifactIds,
  normalizeTaskVerificationDetails,
  publicIncompleteText,
} from './turnTerminalProjection.js'
import {
  excludeVerifiedLocalFiles,
  mergeLocalFileReceipts,
} from './turnRecoveryProjection.js'
import { mergeFailedRetryEvidence } from './turnFailedRetryRejection.js'

export function publicTurnFailureFrameFields(error) {
  const source = error && typeof error === 'object' ? error : {}
  const errorChain = []
  const visitedErrors = new Set()
  let currentError = source
  while (currentError && typeof currentError === 'object'
    && !visitedErrors.has(currentError) && errorChain.length < 8) {
    visitedErrors.add(currentError)
    errorChain.push(currentError)
    currentError = currentError.cause
  }
  const evidence = mergeFailedRetryEvidence(...errorChain)
  const explicitStatus = Number(source.status ?? source.statusCode)
  const recovery = source.recovery && typeof source.recovery === 'object' && !Array.isArray(source.recovery)
    ? {
        status: String(source.recovery.status || 'dead_letter'),
        retryable: source.recovery.retryable === true,
        manualRetryable: source.recovery.manualRetryable === true
          || source.recovery.status === 'dead_letter',
        ...(Number.isInteger(source.recovery.attemptCount)
          ? { attemptCount: source.recovery.attemptCount }
          : {}),
        error: {
          code: String(source.recovery.error?.code
            || source.recovery.errorCode
            || source.code
            || 'TURN_RECOVERY_BLOCKED'),
        },
      }
    : null
  const missingRequirements = [...new Set((Array.isArray(evidence.missingRequirements)
    ? evidence.missingRequirements
    : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 16)
  const taskVerification = normalizeTaskVerificationDetails(evidence.taskVerification)
  const rawNextAction = String(evidence.nextAction || errorChain
    .map((entry) => entry?.nextAction || entry?.error?.nextAction)
    .find(Boolean) || '').trim().toLowerCase().slice(0, 80)
  const nextAction = /^[a-z][a-z0-9_]{0,79}$/u.test(rawNextAction) ? rawNextAction : ''
  const verifiedLocalFiles = mergeLocalFileReceipts(evidence.verifiedLocalFiles).slice(0, 128)
  const retainedLocalFiles = excludeVerifiedLocalFiles(
    mergeLocalFileReceipts(evidence.retainedLocalFiles),
    verifiedLocalFiles,
  ).slice(0, 128)
  const iterations = Number(evidence.iterations)
  return {
    ...(Number.isInteger(explicitStatus) && explicitStatus >= 100 && explicitStatus <= 599
      ? { status: explicitStatus }
      : {}),
    ...(Number.isInteger(source.expectedSequence) && source.expectedSequence >= 0
      ? { expectedSequence: source.expectedSequence }
      : {}),
    ...(Number.isInteger(source.actualSequence) && source.actualSequence >= 0
      ? { actualSequence: source.actualSequence }
      : {}),
    ...(typeof source.retryable === 'boolean' ? { retryable: source.retryable } : {}),
    ...(typeof source.manualRetryable === 'boolean' ? { manualRetryable: source.manualRetryable } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(String(evidence.incompleteReason || '').trim()
      ? { incompleteReason: String(evidence.incompleteReason).trim() }
      : {}),
    ...(missingRequirements.length > 0 ? { missingRequirements } : {}),
    ...(taskVerification ? { taskVerification } : {}),
    ...(Number.isInteger(source.attempts) && source.attempts > 0 ? { attempts: source.attempts } : {}),
    ...(recovery ? { recovery } : {}),
    ...(Object.hasOwn(evidence, 'partialText')
      ? { partialText: publicIncompleteText(evidence.partialText, '') }
      : {}),
    ...(Object.hasOwn(evidence, 'artifactIds')
      ? { artifactIds: normalizeArtifactIds(evidence.artifactIds).slice(0, 64) }
      : {}),
    ...(Object.hasOwn(evidence, 'deliveryArtifactIds')
      ? { deliveryArtifactIds: normalizeArtifactIds(evidence.deliveryArtifactIds).slice(0, 64) }
      : {}),
    ...(Object.hasOwn(evidence, 'verifiedLocalFiles') ? { verifiedLocalFiles } : {}),
    ...(Object.hasOwn(evidence, 'retainedLocalFiles') ? { retainedLocalFiles } : {}),
    ...(Number.isInteger(iterations) && iterations >= 0 ? { iterations } : {}),
  }
}
