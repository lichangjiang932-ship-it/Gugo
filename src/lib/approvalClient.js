import { getAuthToken } from './accountClient.js'

export const RISK_LEVELS = ['high', 'medium', 'low']
export const TOOL_RISK_CLASSES = ['read', 'write_local', 'exec', 'external']

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

export function subscribeToApprovalEvents(onApproval, {
  fetchImpl = fetch,
  EventSourceImpl = globalThis.EventSource,
} = {}) {
  let source = null
  let closed = false
  const connect = async () => {
    if (!EventSourceImpl) return
    try {
      const response = await fetchImpl('/api/approvals/stream-ticket', {
        method: 'POST',
        headers: authHeaders(),
      })
      if (!response.ok || closed) return
      const { ticket } = await response.json()
      if (!ticket || closed) return
      source = new EventSourceImpl(`/api/approvals/stream?ticket=${encodeURIComponent(ticket)}`)
      source.addEventListener('approval', onApproval)
    } catch {
      // REST refresh remains available when realtime transport is unavailable.
    }
  }
  connect()
  return () => {
    closed = true
    try { source?.close() } catch { /* noop */ }
  }
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

/** 兜底值:任何拿不到设置的情况都退回最严格的档位,绝不放宽权限。 */
export const DEFAULT_APPROVAL_SETTINGS = Object.freeze({
  mode: 'normal',
  rememberedTools: [],
  rememberedGrants: [],
  riskOverrides: [],
  modes: PERMISSION_MODES,
})

/**
 * 归一化服务端返回的设置。
 * parse() 在响应体不是 JSON 时会返回 null(比如 dev server 代理不到后端、
 * 返回了 HTML 错误页),直接塞进 state 会让 approvalSettings.mode 读到 null 崩掉。
 */
function normalizeSettings(data) {
  if (!data || typeof data !== 'object') return { ...DEFAULT_APPROVAL_SETTINGS }
  return {
    mode: PERMISSION_MODES.includes(data.mode) ? data.mode : 'normal',
    rememberedTools: Array.isArray(data.rememberedTools) ? data.rememberedTools : [],
    rememberedGrants: Array.isArray(data.rememberedGrants) ? data.rememberedGrants : [],
    riskOverrides: Array.isArray(data.riskOverrides)
      ? data.riskOverrides.filter((item) => item?.toolName && TOOL_RISK_CLASSES.includes(item.riskClass))
      : [],
    modes: Array.isArray(data.modes) && data.modes.length ? data.modes : PERMISSION_MODES,
  }
}

export async function fetchApprovalSettings({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl('/api/approvals/settings', { headers: authHeaders() })
  return normalizeSettings(await parse(res))
}

export async function updateApprovalSettings(patch, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl('/api/approvals/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch || {}),
  })
  return normalizeSettings(await parse(res))
}
