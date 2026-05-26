import { authHeaders, jsonOk } from './agentClient.js'

export async function listCronJobsApi({ agentId } = {}) {
  const qs = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : ''
  const resp = await fetch(`/api/cron-jobs${qs}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function createCronJobApi(payload) {
  const resp = await fetch('/api/cron-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  })
  return jsonOk(resp)
}

export async function updateCronJobApi(id, patch) {
  const resp = await fetch(`/api/cron-jobs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch),
  })
  return jsonOk(resp)
}

export async function deleteCronJobApi(id) {
  const resp = await fetch(`/api/cron-jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function runCronJobNowApi(id) {
  const resp = await fetch(`/api/cron-jobs/${encodeURIComponent(id)}/run-now`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return jsonOk(resp)
}
