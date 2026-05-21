import { getAuthToken } from './accountClient.js'

async function authedJson(url, body) {
  const headers = { 'Content-Type': 'application/json' }
  const token = getAuthToken?.()
  if (token) headers.Authorization = `Bearer ${token}`
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`)
  return data
}

export function compressSession({ sessionId, messages, keepMessages }) {
  return authedJson('/api/compaction/compress', { sessionId, messages, keepMessages })
}

export async function fetchCompactionArchive(id) {
  const headers = {}
  const token = getAuthToken?.()
  if (token) headers.Authorization = `Bearer ${token}`
  const resp = await fetch(`/api/compaction/archive/${encodeURIComponent(id)}`, { headers })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`)
  return data.archive
}
