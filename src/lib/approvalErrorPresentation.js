const ERROR_KEYS = new Map([
  ['UNAUTHORIZED', 'unauthorized'],
  ['NOT_FOUND', 'notFound'],
  ['APPROVAL_NOT_FOUND', 'notFound'],
  ['APPROVAL_EXPIRED', 'expired'],
  ['PERMISSION_APPROVAL_STALE', 'stalePermissions'],
  ['PERMISSION_APPROVAL_INVALID', 'invalidRequest'],
  ['PERMISSION_ESCALATION_REQUIRED', 'escalationRequired'],
  ['PERMISSION_APPROVAL_EDIT_FORBIDDEN', 'editForbidden'],
  ['PERMISSION_APPROVAL_REMEMBER_FORBIDDEN', 'rememberForbidden'],
  ['APPROVAL_EDIT_ARGS_REQUIRED', 'invalidArguments'],
  ['APPROVAL_TARGET_REQUIRED', 'invalidRequest'],
  ['INVALID_APPROVAL_DECISION', 'invalidRequest'],
  ['BAD_REQUEST', 'invalidRequest'],
  ['APPROVAL_DECISION_FAILED', 'unavailable'],
])

const STATUS_KEYS = new Map([
  [400, 'invalidRequest'], [401, 'unauthorized'], [403, 'forbidden'],
  [404, 'notFound'], [409, 'conflict'], [410, 'expired'], [422, 'invalidArguments'],
])

/** Presentation only: never interpret server messages or change approval/retry policy. */
export function approvalErrorKey(error) {
  const code = typeof error?.code === 'string' ? error.code.trim().toUpperCase() : ''
  const status = typeof error?.status === 'number' || typeof error?.status === 'string'
    ? Number(error.status) : NaN
  const key = ERROR_KEYS.get(code) || STATUS_KEYS.get(status)
    || (status >= 500 && status <= 599 ? 'unavailable' : 'unknown')
  return `approvals.errors.${key}`
}

export function localizeApprovalError(error, t) {
  return t(approvalErrorKey(error))
}

/** A persisted, already-decided receipt is not a failed transport or a new decision. */
export function approvalDecisionNoticeKey(result) {
  if (result?.ok !== false || result?.alreadyDecided !== true) return null
  return result.approval?.status === 'expired'
    ? 'approvals.errors.expired' : 'approvals.errors.conflict'
}
