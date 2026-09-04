import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import { describeTurnEngineHostUnavailableError } from '../services/turnEngineHostErrorContract.js'
import { isLocalOwnerUser, resolveAuthMode } from '../adapters/authAccount.js'
import { isLoopbackRequest } from '../utils/loopbackRequest.js'
import { describeSessionCatalogSource } from '../services/sessionCatalogSource.js'

export const LEGACY_SESSION_IMPORT_MAX_BODY_BYTES = 8 * 1024 * 1024

async function resolveSessionAdminPort() {
  const { getSessionAdminPort } = await import('../core/turnPersistenceAdapter.js')
  return getSessionAdminPort()
}

async function resolveTurnEngine(engine) {
  if (engine) return engine
  const { getTurnEngine } = await import('../services/turnEngineHost.js')
  return getTurnEngine()
}

function unauthorized(res) {
  return sendJson(res, 401, { error: 'Unauthorized' })
}

function routeParts(pathname) {
  return pathname.split('/').filter(Boolean)
}

function sendSessionError(res, error) {
  const hostUnavailable = describeTurnEngineHostUnavailableError(error)
  if (hostUnavailable) {
    return sendJson(res, hostUnavailable.statusCode, {
      error: hostUnavailable.error,
    })
  }
  if (error?.statusCode === 413) {
    return sendJson(res, 413, {
      error: {
        code: 'REQUEST_BODY_TOO_LARGE',
        message: 'request body is too large',
      },
    })
  }
  if (error?.code === 'SESSION_REVISION_CONFLICT') {
    return sendJson(res, 409, {
      error: {
        code: error.code,
        message: error.message,
        currentRevision: error.currentRevision,
      },
    })
  }
  if (error?.code === 'LEGACY_SESSION_IMPORT_CONFLICT') {
    return sendJson(res, 409, {
      error: {
        code: error.code,
        message: 'legacy Session import conflicts with server-owned data',
      },
    })
  }
  if (error?.code === 'SESSION_BRANCH_DEPTH_LIMIT') {
    return sendJson(res, 409, {
      error: {
        code: error.code,
        message: error.message,
        maxDepth: error.maxDepth,
      },
    })
  }
  if (typeof error?.code === 'string'
    && error.code.startsWith('TURN_WORKSPACE_')
    && Number.isInteger(error.statusCode)
    && error.statusCode >= 400
    && error.statusCode < 500) {
    return sendJson(res, error.statusCode, {
      error: { code: error.code, message: error.message },
    })
  }
  if (error?.code === 'INVALID_SESSION_MUTATION' || error instanceof SyntaxError) {
    return sendJson(res, 400, {
      error: {
        code: error?.code || 'INVALID_JSON',
        message: error?.message || 'invalid request body',
      },
    })
  }
  if (error?.code === 'SESSION_ADMIN_INPUT_INVALID') {
    return sendJson(res, 400, {
      error: { code: error.code, message: error.message },
    })
  }
  if (error?.code === 'SESSION_ADMIN_RESULT_INVALID') {
    return sendJson(res, 500, {
      error: {
        code: error.code,
        message: 'session persistence backend returned an invalid result',
      },
    })
  }
  throw error
}

const SESSION_METADATA_ACTIONS = Object.freeze({
  archive: 'archiveSession',
  pin: 'pinSession',
  unarchive: 'unarchiveSession',
  unpin: 'unpinSession',
})

async function handleSessionMetadataAction(res, { admin, parts, userId }) {
  const method = SESSION_METADATA_ACTIONS[parts[3]]
  const session = await admin[method]({
    userId,
    sessionId: decodeURIComponent(parts[2]),
  })
  return session
    ? sendJson(res, 200, { ok: true, session })
    : sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: 'session not found' } })
}

async function handleSessionCollectionRequest(req, res, { admin, url, userId, env, cwd }) {
  if (req.method === 'POST' && url.pathname === '/api/sessions/import') {
    if (resolveAuthMode(env) !== 'local'
      || !isLoopbackRequest(req)
      || !isLocalOwnerUser(userId, env)) {
      return sendJson(res, 403, {
        error: {
          code: 'LOCAL_OWNER_ONLY',
          message: 'legacy Session import is limited to the loopback local owner',
        },
      })
    }
    if (typeof admin.importLegacySessions !== 'function') {
      return sendJson(res, 501, {
        error: {
          code: 'LEGACY_SESSION_IMPORT_UNSUPPORTED',
          message: 'the active Session persistence adapter does not support legacy imports',
        },
      })
    }
    if (!describeSessionCatalogSource({ cwd, env, sessionAdmin: admin })) {
      return sendJson(res, 501, {
        error: {
          code: 'LEGACY_SESSION_IMPORT_SOURCE_UNVERIFIED',
          message: 'the active Session persistence adapter has no stable catalog fingerprint',
        },
      })
    }
    const body = await readJson(req, { maxBytes: LEGACY_SESSION_IMPORT_MAX_BODY_BYTES })
    const result = await admin.importLegacySessions({ userId, sessions: body.sessions })
    return sendJson(res, 200, { ok: true, ...result })
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions/search') {
    const results = await admin.searchMessages({
      userId,
      query: url.searchParams.get('q') || '',
      sessionId: url.searchParams.get('sessionId') || null,
      limit: url.searchParams.get('limit') || 20,
      offset: url.searchParams.get('offset') || 0,
    })
    return sendJson(res, 200, { results })
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const sessions = await admin.listSessions({
      userId,
      archived: url.searchParams.get('archived') || 'false',
      limit: url.searchParams.get('limit') || 100,
      offset: url.searchParams.get('offset') || 0,
    })
    return sendJson(res, 200, {
      sessions,
      source: describeSessionCatalogSource({ cwd, env, sessionAdmin: admin }),
    })
  }
  return sendJson(res, 404, { error: 'not found' })
}

export async function handleSessionRequest(
  req,
  res,
  engine = null,
  sessionAdmin = null,
  env = process.env,
  cwd = process.cwd(),
) {
  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)
  try {
  const admin = sessionAdmin || await resolveSessionAdminPort()
  const url = new URL(req.url, 'http://localhost')
  const parts = routeParts(url.pathname)

  if (['/api/sessions', '/api/sessions/import', '/api/sessions/search'].includes(url.pathname)) {
    return await handleSessionCollectionRequest(req, res, { admin, url, userId, env, cwd })
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'sessions' && parts[2]
    && parts[3] === 'snapshot' && parts.length === 4) {
    const snapshot = await admin.getSessionSnapshot({
      userId,
      sessionId: decodeURIComponent(parts[2]),
      limit: url.searchParams.get('limit') || 2000,
      offset: url.searchParams.get('offset') || 0,
    })
    return snapshot
      ? sendJson(res, 200, { snapshot })
      : sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: 'session not found' } })
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'sessions' && parts[2]
    && parts[3] === 'branches' && parts.length === 4) {
    const result = await admin.getSessionBranches({
      userId,
      sessionId: decodeURIComponent(parts[2]),
    })
    return result
      ? sendJson(res, 200, result)
      : sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: 'session not found' } })
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'sessions' && parts[2]
    && parts[3] === 'fork' && parts.length === 4) {
    const sessionId = decodeURIComponent(parts[2])
    const body = await readJson(req, { maxBytes: 64 * 1024 })
    const turnEngine = await resolveTurnEngine(engine)
    if (await turnEngine.hasActiveSession({ userId, sessionId })) {
      return sendJson(res, 409, {
        error: { code: 'SESSION_ACTIVE', message: 'session has an active turn' },
      })
    }
    const result = await admin.forkSession({ userId, sessionId, label: body.label })
    return result
      ? sendJson(res, 201, { ...result, ok: true })
      : sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: 'session not found' } })
  }

  if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'sessions' && parts[2]
    && parts[3] === 'messages' && parts.length === 4) {
    const sessionId = decodeURIComponent(parts[2])
    const body = await readJson(req, { maxBytes: 16 * 1024 * 1024 })
    const turnEngine = await resolveTurnEngine(engine)
    if (await turnEngine.hasActiveSession({ userId, sessionId })) {
      return sendJson(res, 409, {
        error: { code: 'SESSION_ACTIVE', message: 'session has an active turn' },
      })
    }
    const result = await admin.replaceSessionMessages({
      userId,
      sessionId,
      expectedRevision: body.expectedRevision,
      messages: body.messages,
    })
    return result
      ? sendJson(res, 200, { ...result, ok: true })
      : sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: 'session not found' } })
  }

  if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'sessions' && parts[2]
    && parts[3] === 'workspace' && parts.length === 4) {
    if (typeof admin.setSessionWorkspace !== 'function') {
      return sendJson(res, 501, {
        error: {
          code: 'SESSION_WORKSPACE_UPDATE_UNSUPPORTED',
          message: 'the active Session persistence adapter does not support workspace updates',
        },
      })
    }
    const sessionId = decodeURIComponent(parts[2])
    const body = await readJson(req, { maxBytes: 64 * 1024 })
    const session = await admin.setSessionWorkspace({
      userId,
      sessionId,
      workspacePath: body.workspacePath,
    })
    return session
      ? sendJson(res, 200, { ok: true, session })
      : sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: 'session not found' } })
  }

  if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts.length === 3) {
    const sessionId = decodeURIComponent(parts[2])
    const body = await readJson(req, { maxBytes: 64 * 1024 })
    const turnEngine = await resolveTurnEngine(engine)
    if (await turnEngine.hasActiveSession({ userId, sessionId })) {
      return sendJson(res, 409, {
        error: { code: 'SESSION_ACTIVE', message: 'session has an active turn' },
      })
    }
    const result = await admin.deleteSession({
      userId,
      sessionId,
      expectedRevision: body.expectedRevision,
    })
    return result
      ? sendJson(res, 200, { ...result, ok: true })
      : sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: 'session not found' } })
  }

  if (req.method === 'POST'
    && parts[0] === 'api'
    && parts[1] === 'sessions'
    && parts[2]
    && SESSION_METADATA_ACTIONS[parts[3]]
    && parts.length === 4) {
    return await handleSessionMetadataAction(res, { admin, parts, userId })
  }

  return sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    return sendSessionError(res, error)
  }
}
