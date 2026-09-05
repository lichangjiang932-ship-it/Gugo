export function normalizeRetryTransitionRequest({
  jobId,
  userId,
  expectedJobStatus,
  steps,
  modelSnapshot,
  event,
  completedRetryStepIds,
  diagnosticResetStepIds,
  autoRetryWake,
  validateRetry,
  prepareCheckpoints,
}, { retryableJobStatuses }) {
  if (!jobId || !userId) throw new Error('retryJobTransition requires jobId and userId')
  if (!retryableJobStatuses.has(expectedJobStatus)) {
    throw new Error('retryJobTransition requires a retryable expected job status')
  }
  if (!modelSnapshot?.modelName) throw new Error('retryJobTransition requires a model snapshot')
  if (!event?.type || !event?.code) throw new Error('retryJobTransition requires an event')
  const autoRetryStepId = autoRetryWake == null ? null : String(autoRetryWake.stepId || '').trim()
  const autoRetryWakeAt = autoRetryWake == null ? null : Number(autoRetryWake.wakeAt)
  const autoRetryClaimedAt = autoRetryWake == null ? null : Number(autoRetryWake.claimedAt)
  const autoRetryAttempt = autoRetryWake == null ? null : Number(autoRetryWake.retryAttempt)
  const autoRetryClaimToken = autoRetryWake == null ? '' : String(autoRetryWake.claimToken || '')
  if ((event.type === 'auto_retry_started') !== (autoRetryWake != null)
    || (autoRetryWake != null && (
      !autoRetryStepId
      || !Number.isFinite(autoRetryWakeAt)
      || !Number.isFinite(autoRetryClaimedAt)
      || !Number.isInteger(autoRetryAttempt)
      || !autoRetryClaimToken
    ))) {
    throw new Error('retryJobTransition requires a valid automatic-retry wake')
  }
  if (validateRetry != null && typeof validateRetry !== 'function') {
    throw new Error('retryJobTransition validateRetry must be a function')
  }
  if (prepareCheckpoints != null && typeof prepareCheckpoints !== 'function') {
    throw new Error('retryJobTransition prepareCheckpoints must be a function')
  }
  const targets = steps.map((step) => ({
    id: String(step?.id || '').trim(),
    status: String(step?.status || '').trim(),
  }))
  if (targets.some((step) => !step.id || !step.status)
    || new Set(targets.map((step) => step.id)).size !== targets.length) {
    throw new Error('retryJobTransition requires unique step identities and expected statuses')
  }
  const completedRetryIds = new Set(
    (Array.isArray(completedRetryStepIds) ? completedRetryStepIds : [])
      .map((value) => String(value || '').trim()).filter(Boolean),
  )
  const targetIds = new Set(targets.map((step) => step.id))
  if (autoRetryStepId && !targetIds.has(autoRetryStepId)) {
    throw new Error('retryJobTransition automatic-retry wake must target a retried step')
  }
  if ([...completedRetryIds].some((stepId) => !targetIds.has(stepId))) {
    throw new Error('retryJobTransition completed retry steps must be transition targets')
  }
  const diagnosticResetIds = new Set(
    (Array.isArray(diagnosticResetStepIds) ? diagnosticResetStepIds : [])
      .map((value) => String(value || '').trim()).filter(Boolean),
  )
  if ([...diagnosticResetIds].some((stepId) => targetIds.has(stepId))) {
    throw new Error('retryJobTransition diagnostic reset steps must not be transition targets')
  }
  return {
    autoRetryStepId,
    autoRetryWakeAt,
    autoRetryClaimedAt,
    autoRetryAttempt,
    autoRetryClaimToken,
    targets,
    completedRetryIds,
    diagnosticResetIds,
  }
}

export function readRetryTransitionRows({
  db,
  jobId,
  targets,
  completedRetryIds,
  diagnosticResetIds,
}, { isRetryableStepRow }) {
  const readStep = db.prepare(`
    SELECT id, status, kind, output_json
      FROM job_steps
     WHERE id = ? AND job_id = ?
  `)
  const currentSteps = targets.map((target) => ({
    target,
    row: readStep.get(target.id, jobId),
  }))
  if (currentSteps.some(({ target, row }) => (
    !row || row.status !== target.status || !isRetryableStepRow(row, completedRetryIds)
  ))) return null
  const diagnosticResetRows = [...diagnosticResetIds].map((stepId) => readStep.get(stepId, jobId))
  if (diagnosticResetRows.some((row) => !row || row.status !== 'completed')) return null
  return { currentSteps, diagnosticResetRows }
}
