import fs from 'node:fs'
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
import {
  configureWorkspaceOnboarding,
  getWorkspaceOnboardingStatus,
} from '../services/workspaceOnboardingService.js'
import { HTML_ARTIFACT_RESPONSE_CSP } from '../../shared/htmlArtifactPolicy.js'
import { readJson } from '../utils.js'
import { getVerifiedLocalFile } from '../services/verifiedLocalFileService.js'

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
      ...(Array.isArray(error?.locks) ? { locks: error.locks } : {}),
    },
  })
}

function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function contentDisposition(kind, name) {
  const fallback = String(name || 'file')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/["\\\r\n]/g, '_')
    .slice(0, 120) || 'file'
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name || 'file')}`
}

function parseRange(header, size) {
  const match = String(header || '').match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null
  let start = match[1] ? Number(match[1]) : null
  let end = match[2] ? Number(match[2]) : null
  if (start == null && end != null) {
    start = Math.max(0, size - end)
    end = size - 1
  } else {
    start = start ?? 0
    end = end == null ? size - 1 : Math.min(end, size - 1)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null
  return { start, end }
}

function previewSecurityHeaders(preview, mimeType) {
  if (!preview) return {}
  const headers = { 'X-Frame-Options': 'SAMEORIGIN' }
  if (/^text\/html/i.test(mimeType)) headers['Content-Security-Policy'] = HTML_ARTIFACT_RESPONSE_CSP
  if (/^image\/svg\+xml/i.test(mimeType)) {
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
  }
  return headers
}

function streamLocalFile(res, fullPath, range) {
  const stream = fs.createReadStream(fullPath, range || undefined)
  stream.once('error', (error) => {
    console.error('[localFileAccess] read stream error:', error?.message)
    if (!res.headersSent) return sendError(res, error)
    if (!res.destroyed) res.destroy(error)
  })
  stream.pipe(res)
  return stream
}

export async function handleLocalFileAccessRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const verifiedFileDownload = ['GET', 'HEAD'].includes(req.method)
    && url.pathname.startsWith('/api/local-files/verified/')
  const downloadToken = verifiedFileDownload ? url.searchParams.get('token') : ''
  // Browser links and embedded previews cannot attach an Authorization header.
  // Match persisted artifact downloads, but scope query-token auth strictly to
  // the read-only verified receipt endpoint.
  if (downloadToken && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${downloadToken}`
  }
  const userId = authenticateRequest(req)
  if (!userId) {
    return sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '请先登录' } })
  }

  try {
    if (['GET', 'HEAD'].includes(req.method) && url.pathname.startsWith('/api/local-files/verified/')) {
      const fileId = decodeURIComponent(url.pathname.slice('/api/local-files/verified/'.length))
      const file = getVerifiedLocalFile({
        userId,
        sessionId: url.searchParams.get('sessionId'),
        turnId: url.searchParams.get('turnId'),
        fileId,
      })
      const preview = url.searchParams.get('preview') === '1'
      const securityHeaders = previewSecurityHeaders(preview, file.mimeType)
      if (req.headers['if-none-match'] === file.etag) {
        res.writeHead(304, {
          ETag: file.etag,
          'Cache-Control': 'private, no-cache',
          ...securityHeaders,
        })
        return res.end()
      }
      const requestedRange = req.headers.range
      const range = requestedRange ? parseRange(requestedRange, file.size) : null
      if (requestedRange && !range) {
        res.writeHead(416, {
          'Content-Range': `bytes */${file.size}`,
          'Accept-Ranges': 'bytes',
          ...securityHeaders,
        })
        return res.end()
      }
      res.writeHead(range ? 206 : 200, {
        'Content-Type': file.mimeType,
        'Content-Length': String(range ? range.end - range.start + 1 : file.size),
        'Content-Disposition': contentDisposition(preview ? 'inline' : 'attachment', file.filename),
        'Cache-Control': 'private, no-cache',
        'Accept-Ranges': 'bytes',
        ETag: file.etag,
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${file.size}` } : {}),
        ...securityHeaders,
      })
      if (req.method === 'HEAD') return res.end()
      return streamLocalFile(res, file.fullPath, range)
    }

    if (req.method === 'GET' && url.pathname === '/api/local-files') {
      return sendJson(res, 200, {
        ok: true,
        ...getLocalFileAccessStatus({ userId }),
        onboarding: getWorkspaceOnboardingStatus({ userId }),
      })
    }

    if (req.method === 'POST' && url.pathname === '/api/local-files/onboarding') {
      if (!isLoopbackRequest(req)) {
        return sendJson(res, 403, {
          ok: false,
          error: { code: 'LOCAL_ONLY', message: 'Workspace onboarding can only be changed from the service host.' },
        })
      }
      const body = await readJson(req)
      return sendJson(res, 200, {
        ok: true,
        ...configureWorkspaceOnboarding({
          userId,
          rootPath: body.path,
          features: body.features,
          approvalMode: body.approvalMode,
          confirmation: body.confirmation,
          bypassConfirmation: body.bypassConfirmation,
        }),
      })
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
