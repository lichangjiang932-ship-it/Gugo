import { getAuthToken } from './accountClient.js'

async function parseResponse(response) {
  let data
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok || data?.ok === false) {
    const payload = data?.error
    const message = typeof payload === 'string'
      ? payload
      : payload?.message || `Session request failed: HTTP ${response.status}`
    const error = new Error(message)
    error.name = 'SessionRequestError'
    error.code = (typeof payload === 'object' && payload?.code) || 'SESSION_REQUEST_FAILED'
    error.status = response.status
    error.details = typeof payload === 'object' ? payload : null
    throw error
  }
  return data
}

function authHeaders(json = false) {
  const token = getAuthToken()
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function asText(value, fallback = '') {
  if (typeof value === 'string') return value
  if (value == null) return fallback
  try { return JSON.stringify(value) } catch { return String(value) }
}

function normalizeToolArguments(call) {
  return asText(call?.function?.arguments ?? call?.arguments ?? call?.args ?? {}, '{}')
}

function toolTraceFromUiCalls(message) {
  const calls = Array.isArray(message?.meta?.toolCalls) ? message.meta.toolCalls : []
  const assistantCalls = []
  const results = []
  calls.forEach((call, index) => {
    const name = String(call?.function?.name || call?.name || '').trim()
    if (!name) return
    const id = String(call?.id || `${message.id}-tool-${index}`)
    assistantCalls.push({
      id,
      type: 'function',
      function: { name, arguments: normalizeToolArguments(call) },
    })
    const result = Object.prototype.hasOwnProperty.call(call || {}, 'result')
      ? asText(call.result)
      : asText({
          ok: false,
          code: 'tool_result_unavailable',
          error: call?.error || 'The prior tool result was not retained by the browser.',
        })
    results.push({ role: 'tool', tool_call_id: id, name, content: result })
  })
  return assistantCalls.length
    ? [{ role: 'assistant', content: '', tool_calls: assistantCalls }, ...results]
    : null
}

function modelContextFromUiMessage(message) {
  const existing = message?.modelContext && typeof message.modelContext === 'object'
    ? { ...message.modelContext }
    : {}
  const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {}
  const turnId = meta.serverTurnId || existing.turnId
  if (turnId) existing.turnId = String(turnId)
  const explicitTrace = Array.isArray(message?.toolTrace)
    ? message.toolTrace
    : Array.isArray(meta.toolTrace)
      ? meta.toolTrace
      : Array.isArray(existing.toolTrace)
        ? existing.toolTrace
        : null
  const toolTrace = explicitTrace || toolTraceFromUiCalls(message)
  if (toolTrace?.length) existing.toolTrace = toolTrace
  return Object.keys(existing).length ? existing : null
}

export function normalizeSessionMessagesForServer(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map((message) => {
    const createdAt = Number.isFinite(Number(message?.createdAt))
      ? Number(message.createdAt)
      : Number.isFinite(Number(message?.timestamp))
        ? Number(message.timestamp)
        : undefined
    const updatedAt = Number.isFinite(Number(message?.updatedAt))
      ? Number(message.updatedAt)
      : undefined
    const modelContext = modelContextFromUiMessage(message)
    return {
      id: message?.id,
      role: message?.role,
      content: message?.content,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(modelContext ? { modelContext } : {}),
    }
  })
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

export async function pinSessionRemote(sessionId, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/pin`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return parseResponse(response)
}

export async function unpinSessionRemote(sessionId, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/unpin`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return parseResponse(response)
}

export async function getSessionMetadataRemote(sessionId, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(
    `/api/sessions/${encodeURIComponent(sessionId)}/snapshot?limit=1&offset=0`,
    { headers: authHeaders() },
  )
  if (response.status === 404) return null
  const result = await parseResponse(response)
  const snapshot = result?.snapshot
  if (!snapshot?.session || !Number.isInteger(snapshot.revision)) {
    const error = new Error('Session metadata request returned an invalid revision')
    error.name = 'SessionRequestError'
    error.code = 'INVALID_SESSION_REVISION'
    throw error
  }
  return { ...snapshot.session, revision: snapshot.revision }
}

export async function replaceSessionMessagesRemote(
  sessionId,
  { expectedRevision, messages, fetchImpl = fetch } = {},
) {
  const response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'PUT',
    headers: authHeaders(true),
    body: JSON.stringify({
      expectedRevision,
      messages: normalizeSessionMessagesForServer(messages),
    }),
  })
  const result = await parseResponse(response)
  if (!Number.isInteger(result?.revision)) {
    const error = new Error('Session update returned an invalid revision')
    error.name = 'SessionRequestError'
    error.code = 'INVALID_SESSION_REVISION'
    throw error
  }
  return result
}

export async function deleteSessionRemote(
  sessionId,
  { expectedRevision, fetchImpl = fetch } = {},
) {
  const response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: authHeaders(true),
    body: JSON.stringify({ expectedRevision }),
  })
  return parseResponse(response)
}
