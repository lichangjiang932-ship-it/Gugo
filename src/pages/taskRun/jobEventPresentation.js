import { localizedJobModelFailure } from './jobModelFailurePresentation.js'

const JOB_EVENT_KEYS = Object.freeze({
  JOB_CREATED: 'jobEvents.created',
  JOB_TASK_REVIEWED: 'jobEvents.taskReviewed',
  JOB_VERIFICATION_REPAIR_STARTED: 'jobEvents.verificationRepairStarted',
  JOB_VERIFICATION_REPAIR_STALLED: 'jobEvents.verificationRepairStalled',
  JOB_COMPLETED: 'jobEvents.completed',
  JOB_DIRECTORY_AUTHORIZATION_RESUMED: 'jobEvents.directoryAuthorizationResumed',
  JOB_PLAN_REVIEW_REFRESHED: 'jobEvents.planReviewRefreshed',
  JOB_PLAN_APPROVED: 'jobEvents.planApproved',
  JOB_PROCESS_RESTART_RECOVERED: 'jobEvents.processRestartRecovered',
  JOB_APPROVAL_RECOVERED: 'jobEvents.approvalRecovered',
  JOB_USER_RESPONSE_RECEIVED: 'jobEvents.userResponseReceived',
  JOB_STEERING_QUEUED: 'jobEvents.steeringQueued',
  JOB_RETRIED: 'jobEvents.retried',
  JOB_STEP_VERIFIED: 'jobEvents.stepVerified',
  JOB_AWAITING_APPROVAL: 'jobEvents.awaitingApproval',
  JOB_APPROVAL_REJECTED: 'jobEvents.approvalRejected',
  JOB_APPROVAL_RESOLVED: 'jobEvents.approvalResolved',
  JOB_AUTO_RETRY_STARTED: 'jobEvents.autoRetryStarted',
  JOB_STEP_RETRIED: 'jobEvents.stepRetried',
  JOB_AUTO_RETRY_SCHEDULED: 'jobEvents.autoRetryScheduled',
  JOB_CANCEL_REQUESTED: 'jobEvents.cancelRequested',
  JOB_AUTO_RETRY_BLOCKED: 'jobEvents.autoRetryBlocked',
  JOB_WAKE_FIRED: 'jobEvents.wakeFired',
  JOB_EXECUTION_LEASE_RECOVERED: 'jobEvents.executionLeaseRecovered',
  JOB_CANCELLED: 'jobEvents.cancelled',
  JOB_PLAN_APPROVAL_REQUIRED: 'jobEvents.planApprovalRequired',
  JOB_STARTED: 'jobEvents.started',
  JOB_STEP_STARTED: 'jobEvents.stepStarted',
  JOB_STEERING_CONSUMED: 'jobEvents.steeringConsumed',
  JOB_SLEEPING: 'jobEvents.sleeping',
  JOB_AWAITING_USER: 'jobEvents.awaitingUser',
  JOB_NOTIFICATION_FAILED: 'jobEvents.notificationFailed',
  JOB_STEP_COMPLETED: 'jobEvents.stepCompleted',
  JOB_PLAN_PROPOSED: 'jobEvents.planProposed',
})

/** Read presentation copy only for persisted pre-code Job events. */
export function legacyJobEventMessage(event) {
  if (!event || event.code) return ''
  return String(event.message || '').trim()
}

export function localizedJobEventMessage(event, t) {
  const legacy = legacyJobEventMessage(event)
  if (legacy) return legacy
  const code = String(event?.code || '').trim().toUpperCase()
  if (!code || typeof t !== 'function') return ''
  if (code === 'JOB_FAILED') {
    return localizedJobModelFailure(event?.payload, t, t('jobEvents.failed'))
  }
  const key = JOB_EVENT_KEYS[code]
  if (!key) return t('jobEvents.unknown', { code })
  return t(key, event?.params && typeof event.params === 'object' ? event.params : {})
}
