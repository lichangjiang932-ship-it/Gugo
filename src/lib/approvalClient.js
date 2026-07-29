import { getAuthToken } from './accountClient.js'

export const RISK_LEVELS = ['high', 'medium', 'low']

function authHeaders() {
  const token = getAuthToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function parse(res) {
  let data
  try { data = await res.json() } catch { data = null }
  if (!res.ok) {
    throw new Error(data?.error?.message || `请求失败：HTTP ${res.status}`)
  }
  return data
}

export async function fetchApprovals({ status = 'pending', limit = 100, fetchImpl = fetch } = {}) {
  const query = new URLSearchParams({ status, limit: String(limit) })
  const res = await fetchImpl(`/api/approvals?${query}`, { headers: authHeaders() })
  const data = await parse(res)
  return data.approvals || []
}

export async function fetchPendingCount({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl('/api/approvals/pending-count', { headers: authHeaders() })
  const data = await parse(res)
  return data.count || 0
}

export async function fetchApproval(id, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`/api/approvals/${encodeURIComponent(id)}`, { headers: authHeaders() })
  const data = await parse(res)
  return data.approval || null
}

/**
 * @param {'approve'|'deny'|'edit'} decision
 * @param {object} [args] decision='edit' 时的改写参数
 * @param {object} [options]
 * @param {boolean} [options.remember] 批准的同时「总是允许这个工具」
 */
export async function decideApproval(id, decision, args = null, { fetchImpl = fetch, remember = false } = {}) {
  const payload = { decision }
  if (args) payload.args = args
  if (remember) payload.remember = true
  const res = await fetchImpl(`/api/approvals/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  })
  return parse(res)
}

export const PERMISSION_MODES = ['normal', 'acceptEdits', 'plan', 'bypass']

export async function fetchApprovalSettings({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl('/api/approvals/settings', { headers: authHeaders() })
  return parse(res)
}

export async function updateApprovalSettings(patch, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl('/api/approvals/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch || {}),
  })
  return parse(res)
}
