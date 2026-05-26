import { getAuthToken } from './accountClient.js'

async function parseResponse(response) {
  let data
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `请求失败：HTTP ${response.status}`)
  }
  return data
}

function authHeaders() {
  return { Authorization: `Bearer ${getAuthToken()}` }
}

export async function searchSessionMessages({ query, sessionId, limit = 20, offset = 0, fetchImpl = fetch }) {
  const params = new URLSearchParams()
  params.set('q', query || '')
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  if (sessionId) params.set('sessionId', sessionId)
  const response = await fetchImpl(`/api/sessions/search?${params.toString()}`, {
    headers: authHeaders(),
  })
  return parseResponse(response)
}

export async function archiveSessionRemote(sessionId, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return parseResponse(response)
}

export async function unarchiveSessionRemote(sessionId, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/unarchive`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return parseResponse(response)
}
