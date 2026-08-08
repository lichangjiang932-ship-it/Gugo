import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import { getTurnEngine } from '../services/TurnEngine.js'
import {
  archiveSession,
  deleteSession,
  getSessionSnapshot,
  listSessions,
  pinSession,
  replaceSessionMessages,
  SessionMutationValidationError,
  SessionRevisionConflictError,
  unarchiveSession,
  unpinSession,
} from '../services/sessionStore.js'
import { searchMessages } from '../services/sessionSearchService.js'

function unauthorized(res) {
  return sendJson(res, 401, { error: 'Unauthorized' })
}

function routeParts(pathname) {
  return pathname.split('/').filter(Boolean)
}

function sendSessionError(res, error) {
  if (error instanceof SessionRevisionConflictError) {
    return sendJson(res, 409, {
      error: {
        code: error.code,
        message: error.message,
        currentRevision: error.currentRevision,
      },
    })
  }
  if (error instanceof SessionMutationValidationError || error instanceof SyntaxError) {
    return sendJson(res, 400, {
      error: {
        code: error?.code || 'INVALID_JSON',
        message: error?.message || 'invalid request body',
      },
    })
  }
  throw error
}

export async function handleSessionRequest(req, res, engine = getTurnEngine()) {
  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)

  const url = new URL(req.url, 'http://localhost')
  const parts = routeParts(url.pathname)
  try {

  if (req.method === 'GET' && url.pathname === '/api/sessions/search') {
    const results = searchMessages({
      userId,
      query: url.searchParams.get('q') || '',
      sessionId: url.searchParams.get('sessionId') || null,
      limit: url.searchParams.get('limit') || 20,
      offset: url.searchParams.get('offset') || 0,
    })
    return sendJson(res, 200, { results })
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const sessions = listSessions({
      userId,
      archived: url.searchParams.get('archived') || 'false',
      limit: url.searchParams.get('limit') || 100,
      offset: url.searchParams.get('offset') || 0,
    })
    return sendJson(res, 200, { sessions })
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'snapshot') {
    const snapshot = getSessionSnapshot({
      userId,
      sessionId: decodeURIComponent(parts[2]),
      limit: url.searchParams.get('limit') || 2000,
      offset: url.searchParams.get('offset') || 0,
    })
    return snapshot
      ? sendJson(res, 200, { snapshot })
      : sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: 'session not found' } })
  }

  if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'messages') {
    const sessionId = decodeURIComponent(parts[2])
    const body = await readJson(req, { maxBytes: 16 * 1024 * 1024 })
    if (engine.hasActiveSession({ userId, sessionId })) {
      return sendJson(res, 409, {
        error: { code: 'SESSION_ACTIVE', message: 'session has an active turn' },
      })
    }
    const result = replaceSessionMessages({
      userId,
      sessionId,
      expectedRevision: body.expectedRevision,
      messages: body.messages,
    })
    return result
      ? sendJson(res, 200, { ok: true, ...result })
      : sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: 'session not found' } })
  }

  if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts.length === 3) {
    const sessionId = decodeURIComponent(parts[2])
    const body = await readJson(req, { maxBytes: 64 * 1024 })
    if (engine.hasActiveSession({ userId, sessionId })) {
      return sendJson(res, 409, {
        error: { code: 'SESSION_ACTIVE', message: 'session has an active turn' },
      })
    }
    const result = deleteSession({
      userId,
      sessionId,
      expectedRevision: body.expectedRevision,
    })
    return result
      ? sendJson(res, 200, { ok: true, ...result })
      : sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: 'session not found' } })
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'archive') {
    const session = archiveSession({ userId, sessionId: decodeURIComponent(parts[2]) })
    return session
      ? sendJson(res, 200, { ok: true, session })
      : sendJson(res, 404, { error: 'session not found' })
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'unarchive') {
    const session = unarchiveSession({ userId, sessionId: decodeURIComponent(parts[2]) })
    return session
      ? sendJson(res, 200, { ok: true, session })
      : sendJson(res, 404, { error: 'session not found' })
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'pin') {
    const session = pinSession({ userId, sessionId: decodeURIComponent(parts[2]) })
    return session
      ? sendJson(res, 200, { ok: true, session })
      : sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: 'session not found' } })
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'unpin') {
    const session = unpinSession({ userId, sessionId: decodeURIComponent(parts[2]) })
    return session
      ? sendJson(res, 200, { ok: true, session })
      : sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: 'session not found' } })
  }

  return sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    return sendSessionError(res, error)
  }
}
