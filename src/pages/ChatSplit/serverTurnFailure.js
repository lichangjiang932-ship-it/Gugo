function stableServerTurnFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const failure = { ...value }
  for (const field of ['message', 'hint', 'reason']) delete failure[field]
  if (failure.error && typeof failure.error === 'object' && !Array.isArray(failure.error)) {
    failure.error = stableServerTurnFailure(failure.error)
  } else if (Object.hasOwn(failure, 'error')) {
    delete failure.error
  }
  if (failure.cause && typeof failure.cause === 'object' && !Array.isArray(failure.cause)) {
    failure.cause = stableServerTurnFailure(failure.cause)
  } else if (Object.hasOwn(failure, 'cause')) {
    delete failure.cause
  }
  if (failure.recovery && typeof failure.recovery === 'object' && !Array.isArray(failure.recovery)) {
    const recovery = { ...failure.recovery }
    for (const field of ['message', 'hint', 'reason', 'errorMessage']) delete recovery[field]
    if (recovery.error && typeof recovery.error === 'object' && !Array.isArray(recovery.error)) {
      recovery.error = stableServerTurnFailure(recovery.error)
    } else if (Object.hasOwn(recovery, 'error')) {
      delete recovery.error
    }
    if (recovery.cause && typeof recovery.cause === 'object' && !Array.isArray(recovery.cause)) {
      recovery.cause = stableServerTurnFailure(recovery.cause)
    } else if (Object.hasOwn(recovery, 'cause')) {
      delete recovery.cause
    }
    failure.recovery = recovery
  }
  return failure
}

export function normalizeServerTurnFailure(error) {
  const nested = stableServerTurnFailure(error?.serverFailure)
  const failure = {
    ...nested,
    code: String(nested.code || error?.code || 'TURN_REQUEST_FAILED').trim() || 'TURN_REQUEST_FAILED',
  }
  for (const field of [
    'status',
    'action',
    'providerId',
    'modelName',
    'configRevision',
    'details',
    'expectedSequence',
    'actualSequence',
    'recovery',
    'retryable',
    'manualRetryable',
    'retryAfter',
    'incompleteReason',
    'missingRequirements',
    'taskVerification',
    'nextAction',
    'attempts',
  ]) {
    if (failure[field] === undefined && error?.[field] !== undefined) failure[field] = error[field]
  }
  const nestedIncompleteReason = String(failure.incompleteReason || '').trim()
  const outerIncompleteReason = String(error?.incompleteReason || '').trim()
  if (!nestedIncompleteReason && outerIncompleteReason) failure.incompleteReason = outerIncompleteReason
  const nestedNextAction = String(failure.nextAction || '').trim()
  const outerNextAction = String(error?.nextAction || '').trim()
  if (!nestedNextAction && outerNextAction) failure.nextAction = outerNextAction
  const nestedMissingRequirements = Array.isArray(failure.missingRequirements)
    ? failure.missingRequirements.filter(Boolean)
    : []
  const outerMissingRequirements = Array.isArray(error?.missingRequirements)
    ? error.missingRequirements.filter(Boolean)
    : []
  if (nestedMissingRequirements.length === 0 && outerMissingRequirements.length > 0) {
    failure.missingRequirements = outerMissingRequirements
  }
  const nestedTaskVerification = failure.taskVerification
    && typeof failure.taskVerification === 'object'
    && !Array.isArray(failure.taskVerification)
    && Object.keys(failure.taskVerification).length > 0
  const outerTaskVerification = error?.taskVerification
    && typeof error.taskVerification === 'object'
    && !Array.isArray(error.taskVerification)
    && Object.keys(error.taskVerification).length > 0
  if (!nestedTaskVerification && outerTaskVerification) {
    failure.taskVerification = error.taskVerification
  }
  return failure
}

export function terminalFailureEvidenceMeta(error) {
  if (!error || typeof error !== 'object') return {}
  const meta = {}
  if (Object.hasOwn(error, 'partialText')) meta.serverPartialText = String(error.partialText || '')
  // UPDATE_LAST_MESSAGE_META is a merge. Omitting empty failure evidence keeps
  // richer data already received from the terminal event instead of replacing
  // it with an empty transport/reconnect fallback.
  if (Array.isArray(error.artifactIds) && error.artifactIds.length > 0) {
    meta.serverArtifactIds = error.artifactIds
  }
  if (Array.isArray(error.deliveryArtifactIds) && error.deliveryArtifactIds.length > 0) {
    meta.serverDeliveryArtifactIds = error.deliveryArtifactIds
  }
  if (Object.hasOwn(error, 'verifiedLocalFiles') && Array.isArray(error.verifiedLocalFiles)) {
    meta.verifiedLocalFiles = error.verifiedLocalFiles
  }
  if (Object.hasOwn(error, 'retainedLocalFiles') && Array.isArray(error.retainedLocalFiles)) {
    meta.retainedLocalFiles = error.retainedLocalFiles
  }
  if (Number.isInteger(error.iterations) && error.iterations >= 0) {
    meta.serverIterations = error.iterations
  }
  return meta
}
