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
 */
export async function decideApproval(id, decision, args = null, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`/api/approvals/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(args ? { decision, args } : { decision }),
  })
  return parse(res)
}
