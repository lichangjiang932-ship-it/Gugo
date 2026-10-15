const PUBLIC_CODES = new Set([
  'SESSION_ACTIVE', 'SESSION_REVISION_CONFLICT', 'SESSION_NOT_FOUND',
  'SESSION_ACTION_UNSUPPORTED', 'SESSION_MUTATION_REFUSED',
])

/** Public facts only: server prose and transport details must not reach UI state. */
export function normalizeSessionMutationFailure(error) {
  const rawStatus = Number(error?.status ?? error?.statusCode)
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 0
  const rawCode = String(error?.code || '').trim().toUpperCase()
  const code = PUBLIC_CODES.has(rawCode) ? rawCode
    : status === 401 || status === 403 ? 'SESSION_ACCESS_UNAVAILABLE'
      : status === 0 || status === 408 || status >= 500 ? 'SESSION_MUTATION_UNKNOWN'
        : status === 409 ? 'SESSION_REVISION_CONFLICT' : 'SESSION_MUTATION_REFUSED'
  return Object.freeze({ code, status, outcome: code === 'SESSION_MUTATION_UNKNOWN' ? 'unknown' : 'refused' })
}

export function sessionMutationFailureKey(failure, authMode) {
  if (failure?.code === 'SESSION_ACTIVE') return 'nav.deleteActiveHint'
  if (failure?.code === 'SESSION_REVISION_CONFLICT') return 'nav.deleteChangedHint'
  if (failure?.code === 'SESSION_NOT_FOUND') return 'nav.deleteMissingHint'
  if (failure?.code === 'SESSION_ACCESS_UNAVAILABLE') {
    return authMode === 'multi_user' ? 'nav.sessionAccessUnavailable' : 'nav.localServiceReconnect'
  }
  return 'nav.deleteFailedHint'
}
