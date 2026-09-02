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

export const LEGACY_SESSION_IMPORT_BATCH_SIZE = 20

function isStableLegacyMessage(message) {
  const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {}
  return meta.streaming !== true && meta.pendingServerSync !== true
}

export function selectLegacySessionImportCandidates(sessions) {
  if (!Array.isArray(sessions)) return []
  return sessions.flatMap((session) => {
    if (!session?.id || Number.isInteger(session.serverRevision)) return []
    const messages = normalizeSessionMessagesForServer(
      (Array.isArray(session.messages) ? session.messages : []).filter(isStableLegacyMessage),
    )
    return [{
      id: session.id,
      title: session.title || 'Untitled',
      ...(String(session.workspacePath || '').trim()
        ? { workspacePath: String(session.workspacePath).trim() }
        : {}),
      ...(Number.isSafeInteger(session.createdAt) ? { createdAt: session.createdAt } : {}),
      ...(Number.isSafeInteger(session.updatedAt) ? { updatedAt: session.updatedAt } : {}),
      ...(session.lastViewedAt === null || Number.isSafeInteger(session.lastViewedAt)
        ? { lastViewedAt: session.lastViewedAt }
        : {}),
      ...(session.archivedAt === null || Number.isSafeInteger(session.archivedAt)
        ? { archivedAt: session.archivedAt }
        : {}),
      ...(session.pinnedAt === null || Number.isSafeInteger(session.pinnedAt)
        ? { pinnedAt: session.pinnedAt }
        : {}),
      messages,
    }]
  })
}

export async function importLegacySessionsRemote(sessions, {
  fetchImpl = fetch,
  signal,
} = {}) {
  const response = await fetchImpl('/api/sessions/import', {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ sessions }),
    signal,
  })
  const result = await parseResponse(response)
  if (!Array.isArray(result?.results)
    || !Number.isInteger(result?.importedCount)
    || !Number.isInteger(result?.serverAuthoritativeCount)) {
    const error = new Error('Legacy Session import returned an invalid result')
    error.name = 'SessionRequestError'
    error.code = 'INVALID_LEGACY_SESSION_IMPORT_RESULT'
    throw error
  }
  return result
}

export async function importAllLegacySessionsRemote(sessions, {
  fetchImpl = fetch,
  signal,
  batchSize = LEGACY_SESSION_IMPORT_BATCH_SIZE,
} = {}) {
  const size = Math.max(1, Math.min(LEGACY_SESSION_IMPORT_BATCH_SIZE, Math.floor(Number(batchSize)) || 1))
  const results = []
  let importedCount = 0
  let serverAuthoritativeCount = 0
  for (let offset = 0; offset < sessions.length; offset += size) {
    const batch = await importLegacySessionsRemote(sessions.slice(offset, offset + size), {
      fetchImpl,
      signal,
    })
    results.push(...batch.results)
    importedCount += batch.importedCount
    serverAuthoritativeCount += batch.serverAuthoritativeCount
  }
  return { results, importedCount, serverAuthoritativeCount }
}

function invalidCatalogSource(message, code = 'INVALID_SESSION_CATALOG_SOURCE') {
  const error = new Error(message)
  error.name = 'SessionRequestError'
  error.code = code
  return error
}

export function normalizeSessionCatalogSource(source) {
  if (source == null) return null
  const version = Number(source?.version)
  const backendInstanceId = String(source?.backendInstanceId || '').trim()
  const workspaceKey = String(source?.workspaceScope?.key || '').trim()
  const workspacePath = String(source?.workspaceScope?.path || '').trim()
  if (!Number.isInteger(version) || version < 1
    || !backendInstanceId || !workspaceKey || !workspacePath) {
    throw invalidCatalogSource('Session catalog returned invalid source metadata')
  }
  return {
    version,
    backendInstanceId,
    workspaceScope: { key: workspaceKey, path: workspacePath },
  }
}

export function sameSessionCatalogSource(left, right) {
  if (left == null || right == null) return left == null && right == null
  return Number(left.version) === Number(right.version)
    && left.backendInstanceId === right.backendInstanceId
    && left.workspaceScope?.key === right.workspaceScope?.key
}

async function listSessionCatalogPageRemote({
  archived = 'all',
  limit = 200,
  offset = 0,
  fetchImpl = fetch,
  signal,
} = {}) {
  const params = new URLSearchParams({
    archived: String(archived),
    limit: String(limit),
    offset: String(offset),
  })
  const response = await fetchImpl(`/api/sessions?${params.toString()}`, {
    headers: authHeaders(),
    signal,
  })
  const result = await parseResponse(response)
  if (!Array.isArray(result?.sessions)) {
    const error = new Error('Session catalog request returned an invalid result')
    error.name = 'SessionRequestError'
    error.code = 'INVALID_SESSION_CATALOG'
    throw error
  }
  return {
    sessions: result.sessions,
    source: normalizeSessionCatalogSource(result.source),
  }
}

export async function listSessionsRemote(options = {}) {
  const page = await listSessionCatalogPageRemote(options)
  return page.sessions
}

export async function listSessionCatalogRemote({
  archived = 'all',
  fetchImpl = fetch,
  signal,
  pageSize = 200,
} = {}) {
  const sessions = []
  const seen = new Set()
  let offset = 0
  let source

  for (;;) {
    const page = await listSessionCatalogPageRemote({
      archived,
      limit: pageSize,
      offset,
      fetchImpl,
      signal,
    })
    if (source === undefined) source = page.source
    else if (!sameSessionCatalogSource(source, page.source)) {
      throw invalidCatalogSource(
        'Session catalog source changed while loading pages',
        'SESSION_CATALOG_SOURCE_CHANGED',
      )
    }
    let added = 0
    for (const session of page.sessions) {
      const id = String(session?.id || '').trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      sessions.push(session)
      added += 1
    }
    if (page.sessions.length < pageSize || added === 0) break
    offset += page.sessions.length
  }

  return { sessions, source: source ?? null }
}

export async function listAllSessionsRemote(options = {}) {
  return (await listSessionCatalogRemote(options)).sessions
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

export async function setSessionWorkspaceRemote(
  sessionId,
  workspacePath,
  { fetchImpl = fetch } = {},
) {
  const normalizedWorkspacePath = String(workspacePath || '').trim() || null
  const response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/workspace`, {
    method: 'PUT',
    headers: authHeaders(true),
    body: JSON.stringify({ workspacePath: normalizedWorkspacePath }),
  })
  const result = await parseResponse(response)
  if (!result?.session || !Number.isInteger(result.session.revision)) {
    const error = new Error('Session workspace update returned invalid metadata')
    error.name = 'SessionRequestError'
    error.code = 'INVALID_SESSION_WORKSPACE_RESULT'
    throw error
  }
  return result
}

export async function forkSessionRemote(
  sessionId,
  { label = null, fetchImpl = fetch } = {},
) {
  const response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ label }),
  })
  return parseResponse(response)
}

export async function getSessionBranchesRemote(sessionId, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/branches`, {
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
