import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import {
  countActiveCronJobs,
  createCronJob,
  deleteCronJob,
  getCronJob,
  listCronJobs,
  updateCronJob,
} from '../services/cronStore.js'
import { getCronScheduler } from '../services/cronScheduler.js'
import {
  assertAgentModelReady,
  describeModelReadinessFailure,
  isModelReadinessError,
} from '../services/modelReadinessService.js'

function unauthorized(res) {
  return sendJson(res, 401, { error: 'Unauthorized' })
}

function routeParts(pathname) {
  return pathname.split('/').filter(Boolean)
}

function normalizeBody(body = {}) {
  return {
    agentId: body.agentId ?? body.agent_id,
    title: body.title,
    kind: body.kind,
    scheduleType: body.scheduleType ?? body.schedule_type,
    scheduleValue: body.scheduleValue ?? body.schedule_value,
    execType: body.execType ?? body.exec_type,
    execPayload: body.execPayload ?? body.exec_payload ?? body.exec_payload_json,
    grants: body.grants,
    enabled: body.enabled,
  }
}

function firstPayloadValue(payload, keys) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  for (const key of keys) {
    if (Object.hasOwn(payload, key)) return payload[key]
  }
  return undefined
}

function modelBindingFromPayload(payload) {
  const revision = firstPayloadValue(payload, [
    'modelConfigRevision',
    'model_config_revision',
    'configRevision',
    'config_revision',
  ])
  const numericRevision = Number(revision)
  return {
    providerId: String(firstPayloadValue(payload, [
      'modelProviderId',
      'model_provider_id',
      'providerId',
      'provider_id',
    ]) || '').trim(),
    modelName: String(firstPayloadValue(payload, ['modelName', 'model_name']) || '').trim(),
    configRevision: Number.isInteger(numericRevision) && numericRevision > 0
      ? numericRevision
      : null,
  }
}

function sameModelBinding(left, right) {
  return left.providerId === right.providerId
    && left.modelName === right.modelName
    && left.configRevision === right.configRevision
}

function assertPatchedAgentModelReady({ userId, existing, patch }) {
  const execType = patch.execType ?? existing.execType
  if (execType !== 'agent_session') return

  const execPayload = patch.execPayload === undefined
    ? existing.execPayload
    : patch.execPayload
  const previousBinding = modelBindingFromPayload(existing.execPayload)
  const nextBinding = modelBindingFromPayload(execPayload)
  const enabled = patch.enabled ?? existing.enabled
  const switchedToRunnableAgent = enabled
    && patch.execType === 'agent_session'
    && existing.execType !== 'agent_session'
  const explicitlyEnabled = patch.enabled === true
  const changedModelBinding = !sameModelBinding(previousBinding, nextBinding)
  if (!switchedToRunnableAgent && !explicitlyEnabled && !changedModelBinding) return

  assertAgentModelReady({ userId, ...nextBinding })
}

function sendRouteError(res, error, fallbackStatus = 400) {
  if (isModelReadinessError(error)) {
    const failure = describeModelReadinessFailure(error)
    return sendJson(res, failure.statusCode, { error: failure.error })
  }
  return sendJson(res, fallbackStatus, { error: error?.message || String(error) })
}

export async function handleCronRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)

  const url = new URL(req.url, 'http://localhost')
  const parts = routeParts(url.pathname)
  const scheduler = getCronScheduler()

  try {
    if (req.method === 'GET' && url.pathname === '/api/cron-jobs') {
      const agentId = url.searchParams.get('agent_id') || url.searchParams.get('agentId') || undefined
      return sendJson(res, 200, {
        jobs: listCronJobs({ userId, agentId }),
        activeCount: countActiveCronJobs({ userId }),
      })
    }

    if (req.method === 'POST' && url.pathname === '/api/cron-jobs') {
      const body = await readJson(req)
      const normalized = normalizeBody(body)
      if (normalized.execType === 'agent_session') {
        assertAgentModelReady({ userId, ...modelBindingFromPayload(normalized.execPayload) })
      }
      const job = createCronJob({ ...normalized, userId })
      scheduler.rearm(job)
      return sendJson(res, 201, { job, activeCount: countActiveCronJobs({ userId }) })
    }

    if (parts[0] === 'api' && parts[1] === 'cron-jobs' && parts[2]) {
      const jobId = decodeURIComponent(parts[2])

      if (req.method === 'PATCH' && parts.length === 3) {
        const body = await readJson(req)
        const existing = getCronJob(jobId, { userId })
        if (!existing) return sendJson(res, 404, { error: 'cron job not found' })
        const normalized = normalizeBody(body)
        assertPatchedAgentModelReady({ userId, existing, patch: normalized })
        const job = updateCronJob(jobId, normalized, { userId })
        scheduler.rearm(job)
        return sendJson(res, 200, { job, activeCount: countActiveCronJobs({ userId }) })
      }

      if (req.method === 'DELETE' && parts.length === 3) {
        const existing = getCronJob(jobId, { userId })
        if (!existing) return sendJson(res, 404, { error: 'cron job not found' })
        scheduler.disarm(jobId)
        deleteCronJob(jobId, { userId })
        return sendJson(res, 200, { ok: true, activeCount: countActiveCronJobs({ userId }) })
      }

      if (req.method === 'POST' && parts[3] === 'run-now') {
        const existing = getCronJob(jobId, { userId })
        if (!existing) return sendJson(res, 404, { error: 'cron job not found' })
        const result = await scheduler.tick(jobId, { manual: true })
        const status = result.status === 'error' ? 500 : 200
        return sendJson(res, status, { ...result, activeCount: countActiveCronJobs({ userId }) })
      }
    }
  } catch (err) {
    return sendRouteError(res, err)
  }

  return sendJson(res, 404, { error: 'not found' })
}
