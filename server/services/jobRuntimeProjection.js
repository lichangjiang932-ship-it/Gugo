import { getJobWithChildren, updateJobStep } from './jobStore.js'
import {
  buildFinalOutput,
  buildJobOutcomeDiagnostics,
  mergePersistedJobOutcomeFields,
  normalizeJobLocalFileReceipts,
  persistedJobOutcomeFields,
} from './jobWorkflow.js'

export function persistJobOutcomeDiagnostics(jobId, {
  userId = null,
  stepId = null,
  reason = null,
  nextAction = null,
  status = 'failed',
} = {}) {
  const snapshot = getJobWithChildren(jobId, { userId })
  if (!snapshot) return null
  const diagnostics = buildJobOutcomeDiagnostics(snapshot, { reason, nextAction, status })
  const targetStep = (stepId
    ? snapshot.steps.find((step) => step.id === stepId)
    : null)
    || [...snapshot.steps].reverse().find((step) => step.kind === 'finalize')
    || snapshot.steps.at(-1)
  if (targetStep) {
    const priorOutput = targetStep.output && typeof targetStep.output === 'object' && !Array.isArray(targetStep.output)
      ? targetStep.output
      : {}
    updateJobStep(targetStep.id, { output: { ...priorOutput, ...diagnostics } })
  }
  return diagnostics
}

export function latestPersistedOutcomeFields(steps) {
  return mergePersistedJobOutcomeFields(
    ...(Array.isArray(steps) ? steps : []).map((step) => step?.output),
  )
}

function currentStatusEventOutcomeFields(job) {
  const events = Array.isArray(job?.events) ? job.events : []
  const lastEvent = events.at(-1)
  const expectedTypes = {
    awaiting_approval: new Set(['awaiting_approval']),
    cancelled: new Set(['cancelled']),
    completed: new Set(['completed']),
    failed: new Set(['failed']),
    waiting: new Set(['awaiting_user', 'plan_approval_required', 'plan_proposed', 'sleeping']),
  }[job?.status]
  if (!expectedTypes?.has(lastEvent?.type)) return {}
  return persistedJobOutcomeFields(lastEvent.payload)
}

function projectPersistedOutcomeDiagnostics(diagnostics, persisted) {
  const projected = { ...diagnostics }
  for (const field of ['incompleteReason', 'taskVerification', 'retryable', 'manualRetryable']) {
    if (Object.hasOwn(persisted, field)) projected[field] = persisted[field]
  }
  if (Array.isArray(persisted.missingRequirements) && persisted.missingRequirements.length > 0) {
    projected.missingRequirements = persisted.missingRequirements
  }
  const localFiles = normalizeJobLocalFileReceipts({
    verifiedLocalFiles: persisted.verifiedLocalFiles,
    retainedLocalFiles: persisted.retainedLocalFiles,
  })
  if (Object.hasOwn(persisted, 'verifiedLocalFiles')) {
    projected.verifiedLocalFiles = localFiles.verifiedLocalFiles
  }
  if (Object.hasOwn(persisted, 'retainedLocalFiles')) {
    projected.retainedLocalFiles = localFiles.retainedLocalFiles
  }
  projected.nextAction = persisted.nextAction || projected.nextAction
  return projected
}

export function projectJobForClient(job) {
  if (!job) return null
  const persisted = mergePersistedJobOutcomeFields(
    latestPersistedOutcomeFields(job.steps),
    currentStatusEventOutcomeFields(job),
  )
  if (job.status === 'completed') {
    const delivery = buildFinalOutput(job)
    if (delivery.complete !== false) {
      return { ...job, ...delivery, status: 'completed', complete: true, error: null }
    }
    const reason = String(
      delivery.issues?.[0]
        || delivery.incompleteReason
        || delivery.summary
        || '任务交付未全部完成',
    ).trim()
    const diagnostics = projectPersistedOutcomeDiagnostics(buildJobOutcomeDiagnostics(job, {
      reason,
      nextAction: persisted.nextAction || 'retry_job',
      status: 'failed',
    }), persisted)
    return {
      ...job,
      persistedStatus: 'completed',
      ...diagnostics,
      status: 'failed',
      complete: false,
      error: diagnostics.reason || reason,
    }
  }
  if (['failed', 'cancelled', 'waiting', 'awaiting_approval'].includes(job.status)) {
    const diagnostics = projectPersistedOutcomeDiagnostics(buildJobOutcomeDiagnostics(job, {
      reason: persisted.reason || job.error,
      nextAction: persisted.nextAction || {
        awaiting_approval: 'review_approval',
        waiting: 'provide_input',
      }[job.status] || 'retry_job',
      status: job.status,
    }), persisted)
    return {
      ...job,
      ...diagnostics,
    }
  }
  return job
}
