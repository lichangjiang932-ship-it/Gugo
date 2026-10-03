import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import { resolveForFileTool } from '../adapters/fsShellSupport.js'
import {
  previewConfigurationSummaries,
  readPreviewConfig,
  writePreviewAutoVerify,
  writeStarterPreviewConfig,
} from '../services/previewConfig.js'
import {
  readPreviewServerLog,
  readPreviewServerState,
  startPreviewServer,
  stopPreviewServer,
} from '../services/previewServerStore.js'
import { listPendingPageFacts, markPreviewWindowSeen, resolvePageFacts } from '../services/previewPageFacts.js'
import { previewVerificationStatus } from '../services/previewVerification.js'

/**
 * The preview's control surface.
 *
 * The panel is the only caller: it asks what the workspace is configured to run,
 * starts or stops that server, and reads the tail of its log. Nothing here
 * decides what may be executed — the store does, through the same shell
 * authorization every other command passes — so this module only translates
 * between HTTP and those rules.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function sendPreviewError(res, status, code, message) {
  return sendJson(res, status, { ok: false, error: { code, message } })
}

/** The workspace has to be one this user may read before its config is read. */
function authorizeWorkspace(userId, rawRoot) {
  try {
    const resolved = resolveForFileTool(rawRoot, { userId, allowMissing: true })
    return { ok: true, workspaceRoot: resolved.fullPath }
  } catch (error) {
    return { ok: false, code: error?.code || 'PREVIEW_WORKSPACE_DENIED', error: error?.message || String(error) }
  }
}

function sessionIdOf(query) {
  return String(query.get('sessionId') || '').trim().slice(0, 160)
}

function workspaceFrom(query, body) {
  return String(body?.workspaceRoot || query.get('workspaceRoot') || '').trim()
}

function stateOf(userId, workspaceRoot, sessionId = '') {
  const read = readPreviewConfig({ workspaceRoot })
  return {
    ok: true,
    workspaceRoot,
    path: read.path,
    missing: read.missing,
    problems: read.problems,
    autoVerify: read.config?.autoVerify ?? true,
    configurations: previewConfigurationSummaries(read.config),
    server: readPreviewServerState({ userId, workspaceRoot }),
    log: readPreviewServerLog({ userId, workspaceRoot, limit: 2_000 }),
    // What the backend is waiting for the window to look at. The panel performs
    // these against the live page and posts the results back.
    pendingFacts: listPendingPageFacts({ userId, workspaceRoot }),
    // A verification in flight is the app's cue to show the preview: the page it
    // wants facts from is the one in the panel, so somebody has to open it.
    verify: previewVerificationStatus({ userId, sessionId, workspaceRoot }),
  }
}

export async function handlePreviewRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendPreviewError(res, 401, 'AUTH_REQUIRED', '请先登录')
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname
  try {
    if (req.method === 'GET' && pathname === '/api/preview/state') {
      const workspaceRoot = workspaceFrom(url.searchParams, null)
      if (!workspaceRoot) return sendPreviewError(res, 400, 'PREVIEW_WORKSPACE_REQUIRED', '缺少 workspaceRoot')
      const authorized = authorizeWorkspace(userId, workspaceRoot)
      if (!authorized.ok) return sendPreviewError(res, 403, authorized.code, authorized.error)
      // Someone is looking: remember it, so verification knows a page can answer.
      markPreviewWindowSeen({ userId, workspaceRoot: authorized.workspaceRoot })
      return sendJson(res, 200, stateOf(userId, authorized.workspaceRoot, sessionIdOf(url.searchParams)))
    }
    if (req.method !== 'POST') return sendPreviewError(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET / POST')
    const body = await readJson(req)
    const workspaceRoot = workspaceFrom(url.searchParams, body)
    if (!workspaceRoot) return sendPreviewError(res, 400, 'PREVIEW_WORKSPACE_REQUIRED', '缺少 workspaceRoot')
    const authorized = authorizeWorkspace(userId, workspaceRoot)
    if (!authorized.ok) return sendPreviewError(res, 403, authorized.code, authorized.error)
    const scope = { userId, workspaceRoot: authorized.workspaceRoot }
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const sessionId = String(body?.sessionId || sessionIdOf(url.searchParams)).trim().slice(0, 160)

    if (pathname === '/api/preview/start' || pathname === '/api/preview/restart') {
      if (pathname === '/api/preview/restart') await stopPreviewServer(scope)
      const started = await startPreviewServer({ ...scope, name })
      if (!started.ok) {
        // A refusal carries its own status: "not allowed" is a 403, "cannot run"
        // is a 400, and the panel renders the code either way.
        return sendJson(res, started.status || 400, { ok: false, error: { code: started.code, message: started.error } })
      }
      // `reused` is the store's answer to "did this start anything"; the rest of
      // the response is the same state the panel polls, so it can render at once.
      return sendJson(res, 200, { reused: started.reused, ...stateOf(userId, authorized.workspaceRoot, sessionId) })
    }
    if (pathname === '/api/preview/stop') {
      await stopPreviewServer(scope)
      return sendJson(res, 200, { ok: true, ...stateOf(userId, authorized.workspaceRoot, sessionId) })
    }
    if (pathname === '/api/preview/facts') {
      // The window answering a request it picked up from the state it polls.
      const resolved = resolvePageFacts({
        userId,
        workspaceRoot: authorized.workspaceRoot,
        id: body?.id,
        result: { results: body?.results, errors: body?.errors },
      })
      return sendJson(res, 200, { ok: true, ...resolved })
    }
    if (pathname === '/api/preview/setup') {
      const written = writeStarterPreviewConfig({ workspaceRoot: authorized.workspaceRoot })
      if (!written.ok) return sendPreviewError(res, 409, written.code, written.problems.join('；'))
      return sendJson(res, 200, { path: written.path, ...stateOf(userId, authorized.workspaceRoot, sessionId) })
    }
    if (pathname === '/api/preview/auto-verify') {
      const written = writePreviewAutoVerify({ workspaceRoot: authorized.workspaceRoot, autoVerify: body?.autoVerify })
      if (!written.ok) return sendPreviewError(res, 400, 'PREVIEW_CONFIG_WRITE_FAILED', written.problems.join('；'))
      return sendJson(res, 200, { ok: true, ...stateOf(userId, authorized.workspaceRoot, sessionId) })
    }
    return sendPreviewError(res, 404, 'PREVIEW_ROUTE_UNKNOWN', `未知的预览接口：${pathname}`)
  } catch (error) {
    return sendPreviewError(res, 500, error?.code || 'PREVIEW_ROUTE_FAILED', error?.message || String(error))
  }
}
