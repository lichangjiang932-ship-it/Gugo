import { authenticateRequest } from '../middleware.js'
import {
  getLocalFileAccessStatus,
  grantLocalPath,
  pickLocalDirectory,
  resolveAuthorizedLocalPath,
  revokeLocalPath,
  setAllFilesAccess,
} from '../services/localFileAccessService.js'
import { setWorkspaceTrust } from '../services/workspaceTrustService.js'
import { readJson } from '../utils.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function sendError(res, error) {
  sendJson(res, error?.statusCode || 500, {
    ok: false,
    error: {
      code: error?.code || 'LOCAL_FILE_ACCESS_ERROR',
      message: error?.message || '本地文件访问失败',
      ...(error?.path ? { path: error.path } : {}),
      ...(typeof error?.retryable === 'boolean' ? { retryable: error.retryable } : {}),
      ...(error?.hint ? { hint: error.hint } : {}),
    },
  })
}

function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export async function handleLocalFileAccessRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) {
    return sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '请先登录' } })
  }
  const url = new URL(req.url, 'http://localhost')

  try {
    if (req.method === 'GET' && url.pathname === '/api/local-files') {
      return sendJson(res, 200, { ok: true, ...getLocalFileAccessStatus({ userId }) })
    }

    if (req.method === 'POST' && url.pathname === '/api/local-files/grants') {
      const body = await readJson(req)
      const grant = grantLocalPath({
        userId,
        rootPath: body.path,
        accessMode: body.accessMode,
      })
      return sendJson(res, 200, { ok: true, grant, ...getLocalFileAccessStatus({ userId }) })
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/local-files/grants/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/local-files/grants/'.length))
      if (!revokeLocalPath({ userId, id })) {
        return sendJson(res, 404, { ok: false, error: { code: 'GRANT_NOT_FOUND', message: '授权不存在' } })
      }
      return sendJson(res, 200, { ok: true, ...getLocalFileAccessStatus({ userId }) })
    }

    if (req.method === 'POST' && url.pathname === '/api/local-files/all-access') {
      const body = await readJson(req)
      const status = setAllFilesAccess({
        userId,
        enabled: !!body.enabled,
        confirmation: body.confirmation,
      })
      return sendJson(res, 200, { ok: true, ...status })
    }

    if (req.method === 'POST' && url.pathname === '/api/local-files/workspace-trust') {
      const body = await readJson(req)
      const trusted = body.trusted === true
      let rootPath = body.path
      if (trusted) {
        const resolved = resolveAuthorizedLocalPath({
          userId,
          rawPath: rootPath,
          allowWorkspace: true,
        })
        rootPath = resolved.fullPath
      }
      const trust = setWorkspaceTrust({
        userId,
        rootPath,
        trusted,
        confirmation: body.confirmation,
      })
      return sendJson(res, 200, {
        ok: true,
        trust,
        ...getLocalFileAccessStatus({ userId }),
      })
    }

    if (req.method === 'POST' && url.pathname === '/api/local-files/pick-directory') {
      if (!isLoopbackRequest(req)) {
        return sendJson(res, 403, { ok: false, error: { code: 'LOCAL_ONLY', message: '文件夹选择器只能从运行服务的本机打开' } })
      }
      const selectedPath = await pickLocalDirectory()
      return sendJson(res, 200, { ok: true, path: selectedPath })
    }

    return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' } })
  } catch (error) {
    return sendError(res, error)
  }
}
