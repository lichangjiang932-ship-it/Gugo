/**
 * Desk Notes REST 客户端 (Hanako 平行：书桌便笺)
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

export async function listDeskNotesApi({ agent } = {}) {
  const params = new URLSearchParams()
  if (agent !== undefined) params.set('agent', agent === null ? '' : String(agent))
  const qs = params.toString()
  const resp = await fetch(`/api/desk/notes${qs ? `?${qs}` : ''}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function createDeskNoteApi(payload) {
  const resp = await fetch('/api/desk/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload || {}),
  })
  return jsonOk(resp)
}

export async function updateDeskNoteApi(id, patch) {
  const resp = await fetch(`/api/desk/notes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch || {}),
  })
  return jsonOk(resp)
}

export async function deleteDeskNoteApi(id) {
  const resp = await fetch(`/api/desk/notes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  return jsonOk(resp)
}
