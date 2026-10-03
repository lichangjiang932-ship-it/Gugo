import { authHeaders } from './agentClient.js'

/**
 * The preview panel's client.
 *
 * Every call names the workspace it is about: a preview belongs to a project, and
 * the server refuses any workspace this user has not been granted, so the panel
 * cannot start a command in a folder the reader never shared.
 */

async function readJsonResponse(responsePromise) {
  const response = await responsePromise
  let payload
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error?.message || payload?.error || `request failed: ${response.status}`)
    error.code = payload?.error?.code || 'PREVIEW_REQUEST_FAILED'
    error.status = response.status
    throw error
  }
  return payload
}

function post(route, body, fetchImpl) {
  return readJsonResponse(fetchImpl(route, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

export function readPreviewState({ workspaceRoot, sessionId = '', fetchImpl = fetch } = {}) {
  const query = `workspaceRoot=${encodeURIComponent(String(workspaceRoot || ''))}`
  const scoped = sessionId ? `&sessionId=${encodeURIComponent(String(sessionId))}` : ''
  return readJsonResponse(fetchImpl(`/api/preview/state?${query}${scoped}`, { headers: authHeaders() }))
}

export function startPreviewServer({ workspaceRoot, name = '', fetchImpl = fetch } = {}) {
  return post('/api/preview/start', { workspaceRoot, name }, fetchImpl)
}

export function stopPreviewServer({ workspaceRoot, fetchImpl = fetch } = {}) {
  return post('/api/preview/stop', { workspaceRoot }, fetchImpl)
}

export function restartPreviewServer({ workspaceRoot, name = '', fetchImpl = fetch } = {}) {
  return post('/api/preview/restart', { workspaceRoot, name }, fetchImpl)
}

export function setPreviewAutoVerify({ workspaceRoot, autoVerify, fetchImpl = fetch } = {}) {
  return post('/api/preview/auto-verify', { workspaceRoot, autoVerify }, fetchImpl)
}

/** Write the starting `.gugo/launch.json`. The server refuses to overwrite one. */
export function createStarterPreviewConfig({ workspaceRoot, fetchImpl = fetch } = {}) {
  return post('/api/preview/setup', { workspaceRoot }, fetchImpl)
}

/** Answer a page-facts request the backend parked for this window. */
export function deliverPreviewFacts({ workspaceRoot, id, results = [], errors = [], fetchImpl = fetch } = {}) {
  return post('/api/preview/facts', { workspaceRoot, id, results, errors }, fetchImpl)
}
