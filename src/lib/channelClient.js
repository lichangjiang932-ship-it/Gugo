import { authHeaders, jsonOk } from './agentClient.js'

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
