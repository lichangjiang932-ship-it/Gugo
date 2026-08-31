import path from 'node:path'
import { appendJobEvent, updateJob, updateJobStep } from './jobStore.js'
import {
  getJobTurnCheckpoint,
  nextJobCheckpointWriteSequence,
  saveJobTurnCheckpoint,
} from './jobTurnCheckpointStore.js'
import { findAuthorizedDirectoryGrant } from './localFileAccessService.js'
import { mergeDirectoryAuthorizationResolutions } from './turnResolutionRuntime.js'

const JOB_DIRECTORY_RESOLUTION_MARKER = '[JOB_DIRECTORY_RESOLUTION:'
const JOB_SUSPENSION_EVENT_TYPES = new Set([
  'awaiting_user',
  'sleeping',
  'plan_proposed',
  'directory_authorization_resumed',
])

function normalizedDirectoryPath(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const api = path.win32.isAbsolute(raw) ? path.win32 : path.posix
  const normalized = api.normalize(raw).replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function directoryResolutionPrompt({ path: authorizedPath, accessMode, eventId }) {
  return [
    `${JOB_DIRECTORY_RESOLUTION_MARKER}${eventId}]`,
    'The requested local directory authorization is already persisted and verified.',
    `Continue the original task using the exact authorized path ${JSON.stringify(authorizedPath)} with ${accessMode} access.`,
    'Do not call request_directory again for this same path and access mode.',
    'If a later operation fails, handle the concrete new error instead of treating this verified grant as missing.',
  ].join(' ')
}

function latestSuspensionEvent(events) {
  return [...(Array.isArray(events) ? events : [])]
    .reverse()
    .find((event) => JOB_SUSPENSION_EVENT_TYPES.has(event?.type)) || null
}

function matchingResumeEvent(events, { authorizedPath, accessMode }) {
  const normalizedPath = normalizedDirectoryPath(authorizedPath)
  if (!normalizedPath || !accessMode) return null
  return [...(Array.isArray(events) ? events : [])]
    .reverse()
    .find((event) => (
      event?.type === 'directory_authorization_resumed'
      && normalizedDirectoryPath(event?.payload?.path) === normalizedPath
      && String(event?.payload?.accessMode || '').trim() === accessMode
    )) || null
}

export function resumeJobDirectoryAuthorization({
  jobId,
  userId,
  path: authorizedPath,
  accessMode,
  getJob,
  cancelJobWake,
  emit,
} = {}) {
  const job = getJob(jobId, { userId })
  if (!job) return null
  const submittedPath = String(authorizedPath || '').trim()
  const submittedMode = String(accessMode || '').trim()
  const latestSuspension = latestSuspensionEvent(job.events)
  if (job.status !== 'waiting') {
    const resumedEvent = matchingResumeEvent(job.events, {
      authorizedPath: submittedPath,
      accessMode: submittedMode,
    })
    if (resumedEvent) {
      return {
        resumed: true,
        idempotent: true,
        awaitingEventId: resumedEvent.payload?.awaitingEventId || null,
        job,
      }
    }
    return { resumed: false, error: 'job is not waiting for directory authorization', job }
  }
  const clarification = latestSuspension?.payload?.clarification || null
  if (latestSuspension?.type !== 'awaiting_user' || clarification?.request_type !== 'directory') {
    return { resumed: false, error: 'job is not waiting for directory authorization', job }
  }

  const requestedMode = String(clarification.access_mode || 'read_only').trim()
  const requestedPath = String(clarification.suggested_path || '').trim()
  if (!['read_only', 'read_write'].includes(submittedMode) || submittedMode !== requestedMode) {
    return { resumed: false, error: 'directory authorization access mode does not match the pending request', job }
  }
  if (!submittedPath || (requestedPath && normalizedDirectoryPath(submittedPath) !== normalizedDirectoryPath(requestedPath))) {
    return { resumed: false, error: 'directory authorization path does not match the pending request', job }
  }
  const grant = findAuthorizedDirectoryGrant({ userId, rawPath: submittedPath, accessMode: submittedMode })
  if (!grant) return { resumed: false, error: 'the requested directory authorization is not persisted for this user', job }

  const stepId = latestSuspension.stepId || job.steps.find((step) => step.status === 'queued')?.id || null
  const checkpoint = stepId ? getJobTurnCheckpoint({ jobId, stepId, userId }) : null
  if (!checkpoint?.state || !stepId) return { resumed: false, error: 'the paused job checkpoint is unavailable', job }
  const marker = `${JOB_DIRECTORY_RESOLUTION_MARKER}${latestSuspension.id}]`
  const directoryAuthorizationResolution = {
    type: 'directory_authorization',
    approved: true,
    path: submittedPath,
    access_mode: submittedMode,
    resource_type: 'directory',
    awaiting_event_id: latestSuspension.id,
    step_id: stepId,
    grant_id: grant.id,
    authorization_scope: grant.scope,
  }
  const directoryAuthorizationResolutions = mergeDirectoryAuthorizationResolutions(
    checkpoint.state.directoryAuthorizationResolution,
    directoryAuthorizationResolution,
  )
  const messages = Array.isArray(checkpoint.state.messages)
    ? checkpoint.state.messages.map((message) => ({ ...message }))
    : []
  if (!messages.some((message) => message?.role === 'system' && String(message.content || '').includes(marker))) {
    messages.push({
      role: 'system',
      content: directoryResolutionPrompt({ path: submittedPath, accessMode: submittedMode, eventId: latestSuspension.id }),
    })
  }
  const savedCheckpoint = saveJobTurnCheckpoint({
    jobId,
    stepId,
    userId,
    state: {
      ...checkpoint.state,
      checkpointWriteSequence: nextJobCheckpointWriteSequence(checkpoint.state),
      messages,
      directoryAuthorizationResolution: directoryAuthorizationResolutions,
      final: null,
    },
  })
  if (!savedCheckpoint
      || !savedCheckpoint.state?.directoryAuthorizationResolution?.some?.((resolution) => (
        resolution?.awaiting_event_id === latestSuspension.id
      ))) {
    return { resumed: false, error: 'the paused job checkpoint could not be updated', job }
  }
  updateJobStep(stepId, { status: 'queued', error: null, finishedAt: null })
  cancelJobWake({ jobId, userId })
  updateJob(jobId, { status: 'queued', error: null, finishedAt: null })
  emit(appendJobEvent({
    jobId,
    stepId,
    type: 'directory_authorization_resumed',
    message: 'Directory authorization verified; the suspended task has been requeued',
    payload: {
      path: submittedPath,
      accessMode: submittedMode,
      grantId: grant.id,
      awaitingEventId: latestSuspension.id,
    },
  }))
  return { resumed: true, job: getJob(jobId, { userId }) }
}
