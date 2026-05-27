/**
 * Feature 3: 记忆 REST 客户端
 */
import { getAuthToken } from './accountClient.js'

function authHeaders() {
  const token = getAuthToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function jsonOk(resp) {
  const text = await resp.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!resp.ok || data?.ok === false) {
    const err = new Error(data?.error || `HTTP ${resp.status}`)
    err.status = resp.status
    throw err
  }
  return data
}

export async function listMemoriesApi({ type, q, agent } = {}) {
  const params = new URLSearchParams()
  if (type) params.set('type', type)
  if (q) params.set('q', q)
  if (agent) params.set('agent', agent)
  const resp = await fetch(`/api/memory/list?${params.toString()}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getMemoriesByIdsApi(ids = []) {
  const cleanIds = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))]
  if (cleanIds.length === 0) return { ok: true, memories: [] }
  const params = new URLSearchParams({ ids: cleanIds.join(',') })
  const resp = await fetch(`/api/memory/by-ids?${params.toString()}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getMemoryIndex() {
  const resp = await fetch('/api/memory/index', { headers: authHeaders() })
  return jsonOk(resp)
}

export async function upsertMemoryApi(payload) {
  const resp = await fetch('/api/memory/upsert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  })
  return jsonOk(resp)
}

export async function deleteMemoryApi(id) {
  const resp = await fetch(`/api/memory/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function getMemoryBySlug(slug) {
  const resp = await fetch(`/api/memory/wikilink/${encodeURIComponent(slug)}`, { headers: authHeaders() })
  return jsonOk(resp)
}
