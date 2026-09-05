import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import { abortJob as abortJobImpl } from '../services/jobRuntime.js'
import {
  describeModelReadinessFailure,
  isModelReadinessError,
} from '../services/modelReadinessService.js'
import { createStreamTicket, consumeStreamTicket } from '../utils/streamTicket.js'
import {
  getPendingJobModelRequestRecovery,
  resolvePendingJobModelRequest,
} from '../services/jobModelRequestRecoveryService.js'
import { isJobModelFailureError } from '../services/jobModelFailure.js'

function unauthorized(res) {
  return sendJson(res, 401, { error: 'Unauthorized' })
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function routeParts(pathname) {
  return pathname.split('/').filter(Boolean)
}

function sendModelReadinessError(res, error) {
  const failure = describeModelReadinessFailure(error)
  return sendJson(res, failure.statusCode, { error: failure.error })
}

function sendJobModelFailureError(res, error) {
  return sendJson(res, error.statusCode || 502, {
    error: typeof error.toJSON === 'function'
      ? error.toJSON()
      : {
          code: error.code || 'MODEL_UPSTREAM_ERROR',
          message: error.message,
          action: error.action || 'retry',
        },
  })
}

function sendModelRequestRecoveryError(res, error) {
  return sendJson(res, 409, {
    error: {
      code: error.code,
      message: error.message,
      retryable: false,
      unsafeToReplay: true,
      requiresUserVerification: error.requiresUserVerification === true,
      recoveryKind: error.recoveryKind || null,
      modelRequestId: error.modelRequestId || null,
      stepId: error.stepId || null,
      providerId: error.providerId || null,
      modelName: error.modelName || null,
      configRevision: error.configRevision ?? null,
      targetProviderId: error.targetProviderId || null,
      targetModelName: error.targetModelName || null,
      targetConfigRevision: error.targetConfigRevision ?? null,
      action: error.action || null,
      ...(error.checkpointInvalid === true ? { checkpointInvalid: true } : {}),
    },
  })
}

function sendJobModelRequestRecoveryError(res, error) {
  return sendJson(res, error.statusCode || 500, {
    error: {
      code: error.code || 'JOB_MODEL_REQUEST_RECOVERY_FAILED',
      message: error.message || 'Job model request recovery failed',
      retryable: error.retryable === true,
    },
  })
}

function sendJobTransitionError(res, error) {
  return sendJson(res, error.statusCode || 409, {
    error: {
      code: error.code,
      message: error.message,
      retryable: false,
    },
  })
}

function openJobEventStream(req, res, runtime, url) {
  let userId = authenticateRequest(req)
  if (!userId) {
    const ticket = url.searchParams.get('ticket')
    if (ticket) userId = consumeStreamTicket(ticket)
  }
  if (!userId) return unauthorized(res)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  sendSse(res, 'ready', { ok: true })
  const unsubscribe = runtime.subscribe(userId, (event) => sendSse(res, 'job_event', event))
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n')
  }, 15_000)
  heartbeat.unref?.()
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    clearInterval(heartbeat)
    unsubscribe()
  }
  req.on('close', cleanup)
  res.on?.('close', cleanup)
  return undefined
}

async function handleJobCollection(req, res, runtime, { userId, env }) {
  if (req.method === 'POST') {
    const body = await readJson(req)
    const prompt = String(body.prompt || '').trim()
    if (!prompt) return sendJson(res, 400, { error: 'prompt is required' })
    try {
      const job = await runtime.createJob(prompt, {
        userId,
        requirePlanApproval: body.requirePlanApproval === true,
        modelName: typeof body.modelName === 'string' ? body.modelName : '',
        modelProviderId: typeof body.providerId === 'string' ? body.providerId : '',
        autoRetry: body.autoRetry === true || body.autoRetry?.enabled === true
          ? body.autoRetry
          : false,
        env,
      })
      return sendJson(res, 201, { job })
    } catch (error) {
      if (isModelReadinessError(error)) return sendModelReadinessError(res, error)
      if (isJobModelFailureError(error)) return sendJobModelFailureError(res, error)
      throw error
    }
  }
  if (req.method === 'GET') {
    return sendJson(res, 200, { jobs: runtime.listJobs({ userId }) })
  }
  return null
}

async function handleJobModelRecovery(req, res, runtime, { userId, jobId, stepId, parts }) {
  try {
    if (req.method === 'GET' && parts.length === 6) {
      const recovery = getPendingJobModelRequestRecovery({ userId, jobId, stepId })
      return recovery
        ? sendJson(res, 200, { recovery })
        : sendJson(res, 404, { error: 'job model request recovery not found' })
    }
    if (req.method === 'POST' && parts[6] === 'resolve') {
      const body = await readJson(req)
      const recovery = resolvePendingJobModelRequest({
        userId,
        jobId,
        stepId,
        expectedCheckpointRevision: body.checkpointRevision,
        modelRequestId: body.modelRequestId,
        requestFingerprint: body.requestFingerprint,
        providerId: body.providerId,
        modelName: body.modelName,
        configRevision: body.configRevision,
        idempotencyKey: body.idempotencyKey,
        verificationConfirmed: body.verificationConfirmed,
        confirmModelRequestId: body.confirmModelRequestId,
        resolution: body.resolution,
        response: body.response,
        receipt: body.receipt,
        note: body.note,
      })
      return sendJson(res, 200, {
        recovery,
        resume: { ready: recovery.status === 'resolved_pending_resume', jobId, stepId },
      })
    }
    if (req.method === 'POST' && parts[6] === 'resume') {
      const recovery = getPendingJobModelRequestRecovery({ userId, jobId, stepId })
      if (!recovery) return sendJson(res, 404, { error: 'job model request recovery not found' })
      if (recovery.status !== 'resolved_pending_resume') {
        return sendJson(res, 409, {
          error: {
            code: 'JOB_MODEL_REQUEST_RECOVERY_UNRESOLVED',
            message: 'Verify and resolve the model request before continuing the job.',
            retryable: false,
          },
        })
      }
      const job = runtime.retryStep(jobId, stepId, { userId, resetBudget: false })
      return job
        ? sendJson(res, 202, { job, resume: { ready: true, jobId, stepId } })
        : sendJson(res, 404, { error: 'step not found' })
    }
    return null
  } catch (error) {
    if (isModelReadinessError(error)) return sendModelReadinessError(res, error)
    if (['MODEL_REQUEST_OUTCOME_UNKNOWN', 'MODEL_REQUEST_CONTEXT_DRIFT'].includes(error?.code)) {
      return sendModelRequestRecoveryError(res, error)
    }
    if (String(error?.code || '').startsWith('JOB_MODEL_REQUEST_RECOVERY_')) {
      return sendJobModelRequestRecoveryError(res, error)
    }
    throw error
  }
}

function handleJobRetryError(res, error, invalidStatusCode) {
  if (isModelReadinessError(error)) return sendModelReadinessError(res, error)
  if (['MODEL_REQUEST_OUTCOME_UNKNOWN', 'MODEL_REQUEST_CONTEXT_DRIFT'].includes(error?.code)) {
    return sendModelRequestRecoveryError(res, error)
  }
  if (error?.code === 'JOB_PLAN_APPROVAL_REQUIRED') {
    return sendJson(res, 409, { error: error.message, code: error.code })
  }
  if (error?.code === invalidStatusCode) return sendJobTransitionError(res, error)
  throw error
}

async function handleJobStepAction(req, res, runtime, context) {
  const { parts, userId, jobId } = context
  if (req.method === 'POST' && parts[3] === 'steps' && parts[4] && parts[5] === 'retry') {
    try {
      const job = runtime.retryStep(jobId, decodeURIComponent(parts[4]), { userId })
      return job
        ? sendJson(res, 200, { job })
        : sendJson(res, 404, { error: 'step not found' })
    } catch (error) {
      return handleJobRetryError(res, error, 'JOB_STEP_RETRY_STATUS_INVALID')
    }
  }
  if (req.method === 'POST' && parts[3] === 'steps' && parts[4] && parts[5] === 'complete') {
    const body = await readJson(req)
    const stepId = decodeURIComponent(parts[4])
    const step = runtime.getJob(jobId, { userId })?.steps?.find((item) => item.id === stepId)
    if (!step) return sendJson(res, 404, { error: 'step not found' })
    try {
      runtime.completeStep(jobId, stepId, { userId, evidence: body.evidence ?? [] })
      return sendJson(res, 200, { ok: true })
    } catch (error) {
      if (error?.statusCode === 422
        && String(error?.code || '').startsWith('JOB_COMPLETION_EVIDENCE_')) {
        return sendJson(res, 422, { error: error.message, code: error.code })
      }
      if (error?.code === 'JOB_PLAN_APPROVAL_REQUIRED') {
        return sendJson(res, 409, { error: error.message, code: error.code })
      }
      if (error?.code === 'JOB_COMPLETION_STATUS_INVALID') {
        return sendJobTransitionError(res, error)
      }
      throw error
    }
  }
  return null
}

async function handleJobResource(req, res, runtime, context) {
  const { parts, userId, jobId, env } = context
  if (parts[3] === 'steps' && parts[4] && parts[5] === 'model-request-recovery') {
    return handleJobModelRecovery(req, res, runtime, {
      ...context,
      stepId: decodeURIComponent(parts[4]),
    })
  }
  if (req.method === 'GET' && parts.length === 3) {
    const job = runtime.getJob(jobId, { userId })
    return job
      ? sendJson(res, 200, { job })
      : sendJson(res, 404, { error: 'job not found' })
  }
  if (req.method === 'POST' && parts[3] === 'cancel') {
    const job = runtime.requestCancel(jobId, { userId })
    return job
      ? sendJson(res, 200, { job })
      : sendJson(res, 404, { error: 'job not found' })
  }
  if (req.method === 'POST' && parts[3] === 'steer') {
    const body = await readJson(req)
    const content = String(body.content || '').trim()
    if (!content) return sendJson(res, 400, { error: 'content is required' })
    if (content.length > 20_000) {
      return sendJson(res, 400, { error: 'content exceeds 20000 characters' })
    }
    const result = runtime.steerJob(jobId, { userId, content })
    if (!result) return sendJson(res, 404, { error: 'job not found' })
    return sendJson(res, result.accepted ? 202 : 409, result)
  }
  if (req.method === 'POST' && parts[3] === 'directory-authorization' && parts[4] === 'resume') {
    const body = await readJson(req)
    const result = runtime.resumeDirectoryAuthorization(jobId, {
      userId, path: body.path, accessMode: body.accessMode,
    })
    if (!result) return sendJson(res, 404, { error: 'job not found' })
    return sendJson(res, result.resumed ? 202 : 409, result)
  }
  if (req.method === 'POST' && parts[3] === 'plan' && parts[4] === 'approve') {
    const body = String(req.headers['content-type'] || '').includes('application/json')
      ? await readJson(req)
      : {}
    const result = runtime.approvePlan(jobId, {
      userId,
      steps: body.steps ?? null,
      proposalEventId: body.proposalEventId ?? null,
      planDigest: body.planDigest ?? null,
    })
    if (!result) return sendJson(res, 404, { error: 'job not found' })
    return sendJson(res, result.approved ? 200 : 409, result)
  }
  if (req.method === 'POST' && parts[3] === 'abort') {
    const result = abortJobImpl(jobId, { userId })
    return result
      ? sendJson(res, 200, { ok: true })
      : sendJson(res, 404, { error: 'job not found' })
  }
  if (req.method === 'POST' && parts[3] === 'retry') {
    try {
      const job = runtime.retryJob(jobId, { userId })
      return job
        ? sendJson(res, 200, { job })
        : sendJson(res, 404, { error: 'job not found' })
    } catch (error) {
      return handleJobRetryError(res, error, 'JOB_RETRY_STATUS_INVALID')
    }
  }
  const stepResponse = await handleJobStepAction(req, res, runtime, context)
  if (stepResponse !== null) return stepResponse
  if (req.method === 'POST' && parts[3] === 'plan') {
    const body = await readJson(req)
    if (!body.title || !body.steps?.length) {
      return sendJson(res, 400, { error: 'title 和 steps 是必填项' })
    }
    try {
      const job = await runtime.createPlan({
        userId,
        title: body.title,
        prompt: body.prompt || body.title,
        steps: body.steps,
        modelName: typeof body.modelName === 'string' ? body.modelName.trim() || undefined : undefined,
        modelProviderId: typeof body.providerId === 'string' ? body.providerId : '',
        env,
      })
      return sendJson(res, 201, { job })
    } catch (error) {
      if (isModelReadinessError(error)) return sendModelReadinessError(res, error)
      throw error
    }
  }
  return null
}

export async function handleJobRequest(req, res, runtime, { env = process.env } = {}) {
  const url = new URL(req.url, 'http://localhost')
  const parts = routeParts(url.pathname)
  if (req.method === 'POST' && url.pathname === '/api/jobs/stream-ticket') {
    const userId = authenticateRequest(req)
    if (!userId) return unauthorized(res)
    return sendJson(res, 201, { ticket: createStreamTicket(userId), expiresIn: 60 })
  }
  if (req.method === 'GET' && url.pathname === '/api/jobs/stream') {
    return openJobEventStream(req, res, runtime, url)
  }
  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)
  if (url.pathname === '/api/jobs') {
    const response = await handleJobCollection(req, res, runtime, { userId, env })
    if (response !== null) return response
  }
  if (parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
    const response = await handleJobResource(req, res, runtime, {
      parts,
      userId,
      jobId: decodeURIComponent(parts[2]),
      env,
    })
    if (response !== null) return response
  }
  return sendJson(res, 404, { error: 'not found' })
}
