import { authenticateRequest } from '../middleware.js'
import { sendJson } from '../utils.js'
import { archiveSession, listSessions, unarchiveSession } from '../services/sessionStore.js'
import { searchMessages } from '../services/sessionSearchService.js'

function unauthorized(res) {
  return sendJson(res, 401, { error: 'Unauthorized' })
}

function routeParts(pathname) {
  return pathname.split('/').filter(Boolean)
}

export async function handleSessionRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)

  const url = new URL(req.url, 'http://localhost')
  const parts = routeParts(url.pathname)

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

  return sendJson(res, 404, { error: 'not found' })
}
