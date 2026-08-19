import fs from 'node:fs'
import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import {
  getArtifactPreviewRendererStatus,
  handleArtifactDownload,
  renderArtifactPreviewPng,
} from '../services/artifactGen.js'
import {
  artifactHtmlPreviewCsp,
  createArtifactHtmlPreviewSession,
  getArtifactHtmlPreviewAsset,
  getArtifactHtmlPreviewDocument,
  revokeArtifactHtmlPreviewSession,
} from '../services/artifactHtmlPreviewService.js'

function unauthorized(res) {
  return sendJson(res, 401, { error: 'Unauthorized' })
}

function previewError(res, error) {
  res.setHeader('Cache-Control', 'no-store')
  return sendJson(res, error?.statusCode || 500, {
    error: {
      code: String(error?.code || 'ARTIFACT_HTML_PREVIEW_FAILED'),
      message: String(error?.message || 'HTML artifact preview failed'),
    },
  })
}

function previewUnauthorized(res) {
  return previewError(res, {
    statusCode: 401,
    code: 'UNAUTHORIZED',
    message: '请先登录',
  })
}

function previewMethodNotAllowed(res, allow) {
  res.setHeader('Allow', allow)
  return previewError(res, {
    statusCode: 405,
    code: 'METHOD_NOT_ALLOWED',
    message: `仅支持 ${allow}`,
  })
}

function decodeRouteSegment(value) {
  try {
    return decodeURIComponent(String(value || ''))
  } catch {
    const error = new Error('预览路径无效')
    error.statusCode = 400
    error.code = 'ARTIFACT_HTML_PREVIEW_PATH_INVALID'
    throw error
  }
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
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || start >= size) return null
  return { start, end }
}

function sendPreviewDocument(req, res, document) {
  const headers = {
    'Content-Type': document.mimeType,
    'Content-Length': document.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': artifactHtmlPreviewCsp(),
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') res.end()
  else res.end(document.body)
}

function sendPreviewAsset(req, res, asset) {
  const requestedRange = req.headers.range
  const range = requestedRange ? parseRange(requestedRange, asset.size) : null
  if (requestedRange && !range) {
    try { fs.closeSync(asset.fileDescriptor) } catch { /* already unavailable */ }
    res.writeHead(416, {
      'Content-Range': `bytes */${asset.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    })
    res.end()
    return
  }
  const headers = {
    'Content-Type': asset.mimeType,
    'Content-Length': range ? range.end - range.start + 1 : asset.size,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ETag: asset.etag,
  }
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${asset.size}`
  res.writeHead(range ? 206 : 200, headers)
  if (req.method === 'HEAD') {
    try { fs.closeSync(asset.fileDescriptor) } catch { /* already unavailable */ }
    res.end()
    return
  }
  const stream = fs.createReadStream(asset.fullPath, {
    ...(range || {}),
    fd: asset.fileDescriptor,
    autoClose: true,
  })
  stream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 500
      res.end('read error')
    } else {
      res.destroy()
    }
  })
  stream.pipe(res)
}

export async function handleArtifactRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')

  const previewDocumentRoute = url.pathname.match(/^\/api\/artifacts\/previews\/([^/]+)\/index\.html$/)
  if (previewDocumentRoute) {
    if (!['GET', 'HEAD'].includes(req.method)) return previewMethodNotAllowed(res, 'GET, HEAD')
    try {
      const document = getArtifactHtmlPreviewDocument({
        ticket: decodeRouteSegment(previewDocumentRoute[1]),
      })
      return sendPreviewDocument(req, res, document)
    } catch (error) {
      return previewError(res, error)
    }
  }

  const previewAssetRoute = url.pathname.match(/^\/api\/artifacts\/previews\/([^/]+)\/assets\/([^/]+)$/)
  if (previewAssetRoute) {
    if (!['GET', 'HEAD'].includes(req.method)) return previewMethodNotAllowed(res, 'GET, HEAD')
    try {
      const asset = getArtifactHtmlPreviewAsset({
        ticket: decodeRouteSegment(previewAssetRoute[1]),
        assetId: decodeRouteSegment(previewAssetRoute[2]),
      })
      return sendPreviewAsset(req, res, asset)
    } catch (error) {
      return previewError(res, error)
    }
  }

  const previewRevokeRoute = url.pathname.match(/^\/api\/artifacts\/previews\/([^/]+)$/)
  if (previewRevokeRoute) {
    if (req.method !== 'DELETE') return previewMethodNotAllowed(res, 'DELETE')
    const userId = authenticateRequest(req)
    if (!userId) return previewUnauthorized(res)
    try {
      const revoked = revokeArtifactHtmlPreviewSession({
        userId,
        ticket: decodeRouteSegment(previewRevokeRoute[1]),
      })
      if (!revoked) {
        return previewError(res, {
          statusCode: 404,
          code: 'ARTIFACT_HTML_PREVIEW_NOT_FOUND',
          message: '网页预览不存在或无权访问',
        })
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' })
      res.end()
      return
    } catch (error) {
      return previewError(res, error)
    }
  }

  const previewCreateRoute = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/preview-session$/)
  if (previewCreateRoute) {
    if (req.method !== 'POST') return previewMethodNotAllowed(res, 'POST')
    const userId = authenticateRequest(req)
    if (!userId) return previewUnauthorized(res)
    try {
      const session = createArtifactHtmlPreviewSession({
        userId,
        artifactSelector: decodeRouteSegment(previewCreateRoute[1]),
      })
      res.setHeader('Cache-Control', 'no-store')
      return sendJson(res, 201, { url: session.url })
    } catch (error) {
      return previewError(res, error)
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/artifacts/render-preview') {
    const userId = authenticateRequest(req)
    if (!userId) return unauthorized(res)

    const status = await getArtifactPreviewRendererStatus()
    if (!status.available) {
      return sendJson(res, 503, {
        error: 'LibreOffice is not installed; render-preview is unavailable',
        libreOfficePath: '',
      })
    }

    try {
      const body = await readJson(req, { maxBytes: 64 * 1024 })
      const preview = await renderArtifactPreviewPng({
        artifactPath: body.artifactPath,
        page: body.page || 1,
        userId,
      })
      return sendJson(res, 200, preview)
    } catch (err) {
      return sendJson(res, err.statusCode || 500, {
        error: err.message || 'render-preview failed',
      })
    }
  }

  return handleArtifactDownload(req, res)
}
