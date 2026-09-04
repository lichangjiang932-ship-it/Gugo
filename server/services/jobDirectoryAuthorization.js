import path from 'node:path'
import { getDb } from '../db.js'
import { appendJobEvent } from './jobStore.js'
import {
  getJobTurnCheckpoint,
  nextJobCheckpointWriteSequence,
  saveJobTurnCheckpoint,
} from './jobTurnCheckpointStore.js'
import { findAuthorizedDirectoryGrant } from './localFileAccessService.js'
import { mergeDirectoryAuthorizationResolutions } from './turnResolutionRuntime.js'
import {
  clearResumedJobOutcomeDiagnostics,
  mergePersistedJobOutcomeFields,
} from './jobWorkflow.js'

const JOB_DIRECTORY_RESOLUTION_MARKER = '[JOB_DIRECTORY_RESOLUTION:'
const JOB_SUSPENSION_EVENT_TYPES = new Set([
  'awaiting_user',
  'sleeping',
  'plan_proposed',
  'directory_authorization_resumed',
])

function parseJson(value) {
  if (!value) return null
  try { return JSON.parse(value) } catch { return null }
}

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

function buildDirectoryResumeCheckpoint({
  checkpoint,
  latestSuspension,
  stepId,
  submittedPath,
  submittedMode,
  grant,
}) {
  const marker = `${JOB_DIRECTORY_RESOLUTION_MARKER}${latestSuspension.id}]`
  const resolution = {
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
  const resolutions = mergeDirectoryAuthorizationResolutions(
    checkpoint.state.directoryAuthorizationResolution,
    resolution,
  )
  const messages = Array.isArray(checkpoint.state.messages)
    ? checkpoint.state.messages.map((message) => ({ ...message }))
    : []
  if (!messages.some((message) => (
    message?.role === 'system' && String(message.content || '').includes(marker)
  ))) {
    messages.push({
      role: 'system',
      content: directoryResolutionPrompt({
        path: submittedPath,
        accessMode: submittedMode,
        eventId: latestSuspension.id,
      }),
    })
  }
  return { messages, resolutions }
}

function resolvedNonWaitingDirectoryResume(job, submittedPath, submittedMode) {
  if (job.status === 'waiting') return null
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
  const priorResolution = resolvedNonWaitingDirectoryResume(job, submittedPath, submittedMode)
  if (priorResolution) return priorResolution
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
  const {
    messages,
    resolutions: directoryAuthorizationResolutions,
  } = buildDirectoryResumeCheckpoint({
    checkpoint,
    latestSuspension,
    stepId,
    submittedPath,
    submittedMode,
    grant,
  })
  const db = getDb()
  let transition
  try {
    transition = db.transaction(() => {
      const current = db.prepare(`
        SELECT status, cancel_requested FROM jobs WHERE id = ? AND user_id = ?
      `).get(jobId, userId)
      if (!current || current.status !== 'waiting' || current.cancel_requested === 1) {
        return { resumed: false, error: 'job is no longer waiting for directory authorization' }
      }
      const currentSuspension = db.prepare(`
        SELECT id, type FROM job_events
         WHERE job_id = ?
           AND type IN ('awaiting_user', 'sleeping', 'plan_proposed', 'directory_authorization_resumed')
         ORDER BY id DESC LIMIT 1
      `).get(jobId)
      if (currentSuspension?.id !== latestSuspension.id || currentSuspension.type !== 'awaiting_user') {
        return { resumed: false, error: 'the pending directory authorization request has changed' }
      }
      const currentStep = db.prepare(`
        SELECT status, output_json FROM job_steps WHERE id = ? AND job_id = ?
      `).get(stepId, jobId)
      if (currentStep?.status !== 'queued') {
        return { resumed: false, error: 'the paused job step is no longer resumable' }
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
        const error = new Error('the paused job checkpoint could not be updated')
        error.code = 'JOB_DIRECTORY_CHECKPOINT_UPDATE_FAILED'
        throw error
      }
      const stepChanged = db.prepare(`
        UPDATE job_steps
           SET status = 'queued', output_json = ?, error = NULL, finished_at = NULL, updated_at = ?
         WHERE id = ? AND job_id = ? AND status = 'queued'
      `).run(
        JSON.stringify(clearResumedJobOutcomeDiagnostics(parseJson(currentStep.output_json)) || {}),
        Date.now(),
        stepId,
        jobId,
      ).changes === 1
      if (!stepChanged) throw new Error('directory authorization step resume lost its compare-and-swap race')
      cancelJobWake({ jobId, userId })
      const jobChanged = db.prepare(`
        UPDATE jobs
           SET status = 'queued', error = NULL, finished_at = NULL, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'waiting' AND cancel_requested = 0
      `).run(Date.now(), jobId, userId).changes === 1
      if (!jobChanged) throw new Error('directory authorization resume lost its compare-and-swap race')
      const event = appendJobEvent({
        jobId,
        stepId,
        type: 'directory_authorization_resumed',
        code: 'JOB_DIRECTORY_AUTHORIZATION_RESUMED',
        payload: {
          ...mergePersistedJobOutcomeFields(
            latestSuspension.payload,
            parseJson(currentStep.output_json),
          ),
          path: submittedPath,
          accessMode: submittedMode,
          grantId: grant.id,
          awaitingEventId: latestSuspension.id,
          nextAction: 'resume_execution',
        },
      })
      return { resumed: true, event }
    }).immediate()
  } catch (error) {
    if (error?.code === 'JOB_DIRECTORY_CHECKPOINT_UPDATE_FAILED') {
      return { resumed: false, error: error.message, job }
    }
    throw error
  }
  if (!transition.resumed) return { ...transition, job: getJob(jobId, { userId }) }
  emit(transition.event)
  return { resumed: true, job: getJob(jobId, { userId }) }
}
