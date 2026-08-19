import fs from 'node:fs'
import { authenticateRequest } from '../middleware.js'
import {
  browseLocalDirectories,
  getLocalFileAccessStatus,
  grantLocalPath,
  resolveAuthorizedLocalPath,
  revokeLocalPath,
  setAllFilesAccess,
  setDefaultOutputDirectory,
} from '../services/localFileAccessService.js'
import { setWorkspaceTrust } from '../services/workspaceTrustService.js'
import {
  configureWorkspaceOnboarding,
  getWorkspaceOnboardingStatus,
} from '../services/workspaceOnboardingService.js'
import { HTML_ARTIFACT_RESPONSE_CSP } from '../../shared/htmlArtifactPolicy.js'
import { readJson } from '../utils.js'
import {
  getRetainedLocalFile,
  getVerifiedLocalFile,
} from '../services/verifiedLocalFileService.js'
import {
  createLocalHtmlPreviewSession,
  getLocalHtmlPreviewResource,
  revokeLocalHtmlPreviewSession,
} from '../services/localHtmlPreviewService.js'
import { htmlPreviewRemoteImageOrigins } from '../services/htmlPreviewRemoteImagePolicy.js'

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

function isTrue(value) {
  return ['1', 'true'].includes(String(value || '').trim().toLowerCase())
}

function httpOrigin(raw, label = 'public URL') {
  const url = new URL(String(raw || ''))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label} must be an HTTP(S) origin`)
  }
  return url.origin
}

function localPreviewRequestOrigin(req, env = process.env) {
  const configured = String(env.APP_PUBLIC_URL || '').trim()
  if (configured) return httpOrigin(configured, 'APP_PUBLIC_URL')

  let protocol = req.socket?.encrypted ? 'https' : 'http'
  let host = String(req.headers?.host || '').split(',')[0].trim()
  if (isTrue(env.TRUST_PROXY)) {
    const forwardedProtocol = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
    const forwardedHost = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim()
    if (forwardedProtocol) protocol = forwardedProtocol
    if (forwardedHost) host = forwardedHost
  }
  if (!host) throw new Error('request Host header is required')
  return httpOrigin(`${protocol}://${host}`, 'request origin')
}

function localHtmlPreviewSecurityHeaders(req, mimeType, ticket, { isEntryDocument = false } = {}) {
  if (!/^text\/html/i.test(mimeType)) return {}
  let resourceSource = "'none'"
  try {
    const origin = localPreviewRequestOrigin(req)
    resourceSource = `${origin}/api/local-files/previews/${ticket}/`
  } catch {
    // A browser request always has a valid Host header. Failing closed keeps a
    // malformed proxy request from widening this capability-scoped policy.
  }
  const remoteImageSources = htmlPreviewRemoteImageOrigins().join(' ')
  return {
    ...(isEntryDocument ? { 'X-Frame-Options': 'SAMEORIGIN' } : {}),
    'Content-Security-Policy': [
      'sandbox',
      ...(isEntryDocument ? ["frame-ancestors 'self'"] : []),
      "default-src 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "form-action 'none'",
      `img-src data: blob: ${resourceSource}${remoteImageSources ? ` ${remoteImageSources}` : ''}`,
      `media-src data: blob: ${resourceSource}`,
      `font-src data: blob: ${resourceSource}`,
      `style-src 'unsafe-inline' ${resourceSource}`,
      "script-src 'none'",
      "worker-src 'none'",
      "connect-src 'none'",
      `frame-src ${resourceSource}`,
      `manifest-src ${resourceSource}`,
    ].join('; '),
  }
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
  const localPreviewPrefix = '/api/local-files/previews/'
  const localPreviewResource = ['GET', 'HEAD'].includes(req.method)
    && url.pathname.startsWith(localPreviewPrefix)

  // The unguessable preview ticket is a short-lived, read-only capability
  // scoped to one verified HTML entry and its statically validated dependency
  // graph. Keeping it in the path lets nested CSS/JS/font/image URLs resolve
  // naturally without exposing the user's account token to the sandbox.
  if (localPreviewResource) {
    try {
      const remainder = url.pathname.slice(localPreviewPrefix.length)
      const separator = remainder.indexOf('/')
      if (separator <= 0) {
        const error = new Error('网页预览地址无效')
        error.statusCode = 404
        error.code = 'LOCAL_HTML_PREVIEW_URL_INVALID'
        throw error
      }
      const ticket = decodeURIComponent(remainder.slice(0, separator))
      const resourcePath = remainder.slice(separator + 1)
      const file = getLocalHtmlPreviewResource({ ticket, resourcePath })
      const securityHeaders = localHtmlPreviewSecurityHeaders(req, file.mimeType, ticket, file)
      if (file.isFrameTarget && !file.isEntryDocument) res.removeHeader('X-Frame-Options')
      if (req.headers['if-none-match'] === file.etag) {
        res.writeHead(304, {
          ETag: file.etag,
          'Cache-Control': 'private, no-cache',
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
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
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          ...securityHeaders,
        })
        return res.end()
      }
      res.writeHead(range ? 206 : 200, {
        'Content-Type': file.mimeType,
        'Content-Length': String(range ? range.end - range.start + 1 : file.size),
        'Content-Disposition': contentDisposition('inline', file.filename),
        'Cache-Control': 'private, no-cache',
        'Accept-Ranges': 'bytes',
        ETag: file.etag,
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${file.size}` } : {}),
        ...securityHeaders,
      })
      if (req.method === 'HEAD') return res.end()
      return streamLocalFile(res, file.fullPath, range)
    } catch (error) {
      return sendError(res, error)
    }
  }

  const receiptFileDownload = ['GET', 'HEAD'].includes(req.method)
    && /^\/api\/local-files\/(?:verified|retained)\//.test(url.pathname)
  const downloadToken = receiptFileDownload ? url.searchParams.get('token') : ''
  // Browser links and embedded previews cannot attach an Authorization header.
  // Match persisted artifact downloads, but scope query-token auth strictly to
  // the read-only verified/retained receipt endpoints.
  if (downloadToken && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${downloadToken}`
  }
  const userId = authenticateRequest(req)
  if (!userId) {
    return sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '请先登录' } })
  }

  try {
    const previewRevokeMatch = req.method === 'DELETE'
      ? url.pathname.match(/^\/api\/local-files\/previews\/([^/]+)\/?$/)
      : null
    if (previewRevokeMatch) {
      revokeLocalHtmlPreviewSession({
        userId,
        ticket: decodeURIComponent(previewRevokeMatch[1]),
      })
      res.writeHead(204)
      return res.end()
    }

    const previewSessionMatch = req.method === 'POST'
      ? url.pathname.match(/^\/api\/local-files\/(verified|retained)\/([^/]+)\/preview-session\/?$/)
      : null
    if (previewSessionMatch) {
      const receiptKind = previewSessionMatch[1]
      const fileId = decodeURIComponent(previewSessionMatch[2])
      const previewSession = await createLocalHtmlPreviewSession({
        userId,
        sessionId: url.searchParams.get('sessionId'),
        turnId: url.searchParams.get('turnId'),
        fileId,
        receiptKind,
      })
      return sendJson(res, 200, { ok: true, ...previewSession })
    }

    const receiptFileMatch = ['GET', 'HEAD'].includes(req.method)
      ? url.pathname.match(/^\/api\/local-files\/(verified|retained)\/([^/]+)\/?$/)
      : null
    if (receiptFileMatch) {
      const receiptKind = receiptFileMatch[1]
      const fileId = decodeURIComponent(receiptFileMatch[2])
      const file = (receiptKind === 'retained' ? getRetainedLocalFile : getVerifiedLocalFile)({
        userId,
        sessionId: url.searchParams.get('sessionId'),
        turnId: url.searchParams.get('turnId'),
        fileId,
      })
      const preview = url.searchParams.get('preview') === '1'
      if (
        preview
        && url.searchParams.has('token')
        && /^text\/html/i.test(file.mimeType)
      ) {
        const error = new Error('本地 HTML 必须通过隔离预览会话打开')
        error.statusCode = 400
        error.code = 'LOCAL_HTML_QUERY_TOKEN_PREVIEW_FORBIDDEN'
        throw error
      }
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
        scope: body.scope,
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
        scope: body.scope,
      })
      return sendJson(res, 200, {
        ok: true,
        trust,
        ...getLocalFileAccessStatus({ userId }),
      })
    }

    if (req.method === 'POST' && url.pathname === '/api/local-files/browse-directories') {
      if (!isLoopbackRequest(req)) {
        return sendJson(res, 403, { ok: false, error: { code: 'LOCAL_ONLY', message: '目录浏览只能从运行服务的本机使用' } })
      }
      const body = await readJson(req)
      const directory = browseLocalDirectories({ userId, rawPath: body.path })
      return sendJson(res, 200, { ok: true, directory })
    }

    if (req.method === 'POST' && url.pathname === '/api/local-files/default-output-directory') {
      const body = await readJson(req)
      const status = setDefaultOutputDirectory({ userId, rootPath: body.path })
      return sendJson(res, 200, { ok: true, ...status })
    }

    return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' } })
  } catch (error) {
    return sendError(res, error)
  }
}
