import { authHeaders, jsonOk } from './agentClient.js'
import { subscribeToTicketedSse } from './ticketedSseClient.js'

function qs(params = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value)
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export async function listChannelsApi({ archived = 'false' } = {}) {
  const resp = await fetch(`/api/channels${qs({ archived })}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function createChannelApi(payload) {
  const resp = await fetch('/api/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  })
  return jsonOk(resp)
}

export async function getChannelApi(id) {
  const resp = await fetch(`/api/channels/${encodeURIComponent(id)}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function updateChannelApi(id, patch) {
  const resp = await fetch(`/api/channels/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch),
  })
  return jsonOk(resp)
}

export async function archiveChannelApi(id) {
  const resp = await fetch(`/api/channels/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function addChannelAgentApi(id, payload) {
  const resp = await fetch(`/api/channels/${encodeURIComponent(id)}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  })
  return jsonOk(resp)
}

export async function removeChannelAgentApi(id, agentId) {
  const resp = await fetch(`/api/channels/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function listChannelMessagesApi(id, { limit = 50, before = null } = {}) {
  const resp = await fetch(`/api/channels/${encodeURIComponent(id)}/messages${qs({ limit, before })}`, {
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function sendChannelMessageApi(id, content) {
  const resp = await fetch(`/api/channels/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ content }),
  })
  return jsonOk(resp)
}

export function channelStreamUrl(id) {
  return `/api/channels/${encodeURIComponent(id)}/stream`
}

export function subscribeToChannelMessages(id, onMessage, options = {}) {
  const channelId = String(id || '').trim()
  const EventSourceImpl = Object.prototype.hasOwnProperty.call(options, 'EventSourceImpl')
    ? options.EventSourceImpl
    : globalThis.EventSource
  if (!channelId || !EventSourceImpl || typeof onMessage !== 'function') return () => {}
  const encodedId = encodeURIComponent(channelId)
  return subscribeToTicketedSse({
    ...options,
    EventSourceImpl,
    ticketUrl: `/api/channels/${encodedId}/stream-ticket`,
    streamUrl: (ticket) => `/api/channels/${encodedId}/stream?ticket=${encodeURIComponent(ticket)}`,
    eventName: 'channel_message',
    headers: authHeaders,
    onEvent: (event) => {
      try { onMessage(JSON.parse(event.data)) } catch { /* malformed event */ }
    },
  })
}

export function mergeChannelMessages(current, incoming) {
  const records = new Map()
  let order = 0
  for (const message of [...(current || []), ...(incoming || [])]) {
    const key = message?.id == null ? `missing-${order}` : String(message.id)
    const existing = records.get(key)
    records.set(key, { message, order: existing?.order ?? order })
    order += 1
  }
  return [...records.values()]
    .sort((left, right) => {
      const leftTime = Number(left.message?.createdAt)
      const rightTime = Number(right.message?.createdAt)
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime
      }
      return left.order - right.order
    })
    .map((entry) => entry.message)
}

export function startChannelMessageSync({
  channelId,
  applyMessages,
  reportError = () => {},
  listMessages = listChannelMessagesApi,
  subscribe = subscribeToChannelMessages,
} = {}) {
  if (!channelId || typeof applyMessages !== 'function') return () => {}
  let cancelled = false

  const reconcile = (surfaceError = false) => listMessages(channelId, { limit: 50 })
    .then((data) => {
      if (!cancelled) applyMessages(data.messages || [])
    })
    .catch((error) => {
      if (!cancelled && surfaceError) reportError(error)
    })

  void reconcile(true)
  const close = subscribe(channelId, (message) => {
    if (!cancelled) applyMessages([message])
  }, {
    onConnectionChange: ({ state }) => {
      if (state === 'open' && !cancelled) void reconcile()
    },
  })

  return () => {
    cancelled = true
    close()
  }
}
