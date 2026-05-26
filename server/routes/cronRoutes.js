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
    enabled: body.enabled,
  }
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
      const job = createCronJob({ ...normalizeBody(body), userId })
      scheduler.rearm(job)
      return sendJson(res, 201, { job, activeCount: countActiveCronJobs({ userId }) })
    }

    if (parts[0] === 'api' && parts[1] === 'cron-jobs' && parts[2]) {
      const jobId = decodeURIComponent(parts[2])

      if (req.method === 'PATCH' && parts.length === 3) {
        const body = await readJson(req)
        const job = updateCronJob(jobId, normalizeBody(body), { userId })
        if (!job) return sendJson(res, 404, { error: 'cron job not found' })
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
    return sendJson(res, 400, { error: err?.message || String(err) })
  }

  return sendJson(res, 404, { error: 'not found' })
}
