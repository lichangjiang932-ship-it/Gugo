function requiredScopeText(value, name, maxLength = 500) {
  const normalized = String(value || '').trim().slice(0, maxLength)
  if (!normalized) throw new TypeError(`${name} is required`)
  return normalized
}

export function optionalSideEffectText(value, maxLength = 500) {
  const normalized = String(value || '').trim().slice(0, maxLength)
  return normalized || null
}

export function createSideEffectScope({ job, step, approvalOrigin, approvalSessionId } = {}) {
  const ownerId = requiredScopeText(job?.userId, 'ownerId')
  const jobId = requiredScopeText(job?.id, 'job.id')
  const stepId = requiredScopeText(step?.id, 'step.id')
  const availableSessionId = optionalSideEffectText(approvalSessionId || job?.sessionId)
  // Production chat entry points declare approvalOrigin='chat' and must always
  // provide a real session identity. Lower-level Loop callers may label a job as
  // chat-originated without carrying chat transport context; keep those calls
  // durable under their explicit job/step identity instead of disabling the
  // ledger or inventing a shared session.
  if (approvalOrigin === 'chat' || (job?.origin === 'chat' && availableSessionId)) {
    const sessionId = requiredScopeText(availableSessionId, 'sessionId')
    return {
      ownerId,
      kind: 'turn',
      scopeKey: JSON.stringify(['turn', sessionId, jobId]),
      sessionId,
      turnId: jobId,
      jobId: null,
      stepId,
    }
  }
  return {
    ownerId,
    kind: 'job',
    scopeKey: JSON.stringify(['job', jobId, stepId]),
    sessionId: optionalSideEffectText(job?.sessionId),
    turnId: null,
    jobId,
    stepId,
  }
}
