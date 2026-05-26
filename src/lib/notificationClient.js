import { getAuthToken } from './accountClient.js'

function authHeaders() {
  const token = getAuthToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function jsonOk(responsePromise) {
  const response = await responsePromise
  let data
  try {
    data = await response.json()
  } catch {
    data = {}
  }
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `HTTP ${response.status}`)
  }
  return data
}

export function listNotifications({ unread = false, limit = 20, offset = 0 } = {}, { fetchImpl = fetch } = {}) {
  const qs = new URLSearchParams()
  if (unread) qs.set('unread', '1')
  if (limit) qs.set('limit', String(limit))
  if (offset) qs.set('offset', String(offset))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return jsonOk(fetchImpl(`/api/notifications${suffix}`, { headers: authHeaders() }))
}

export function getUnreadNotificationCount({ fetchImpl = fetch } = {}) {
  return jsonOk(fetchImpl('/api/notifications/unread-count', { headers: authHeaders() }))
}

export function markNotificationsRead({ ids, all = false } = {}, { fetchImpl = fetch } = {}) {
  return jsonOk(fetchImpl('/api/notifications/mark-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(all ? { all: true } : { ids }),
  }))
}

export function deleteNotification(id, { fetchImpl = fetch } = {}) {
  return jsonOk(fetchImpl(`/api/notifications/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  }))
}

export function subscribeToNotifications(onNotification, { EventSourceImpl = globalThis.EventSource } = {}) {
  if (!EventSourceImpl || typeof onNotification !== 'function') return () => {}
  const token = getAuthToken?.()
  if (!token) return () => {}
  const stream = new EventSourceImpl(`/api/notifications/stream?token=${encodeURIComponent(token)}`)
  const handler = (event) => {
    try {
      onNotification(JSON.parse(event.data))
    } catch {
      // Ignore malformed SSE messages and keep the stream alive.
    }
  }
  stream.addEventListener('notification', handler)
  return () => stream.close()
}
