export function isValidRuntimeIdentity(value) {
  return typeof value === 'string' && Boolean(value.trim())
}

export function hasValidPersistedJobIdentity(job) {
  return isValidRuntimeIdentity(job?.id) && isValidRuntimeIdentity(job?.userId)
}

export function requireRuntimeJobId(jobId, operation) {
  if (!isValidRuntimeIdentity(jobId)) {
    throw new TypeError(`${operation} requires a non-empty jobId string`)
  }
}

export function requireRuntimeUserId(userId, operation) {
  if (!isValidRuntimeIdentity(userId)) {
    throw new TypeError(`${operation} requires a non-empty userId string`)
  }
}
