import fs from 'node:fs'
import {
  projectManagedAttachmentDto,
  projectManagedAttachmentList,
} from '../core/managedAttachmentDtos.js'
import { authenticateRequest } from '../middleware.js'
import { sendJson } from '../utils.js'
import {
  cleanupManagedAttachments,
  createManagedAttachment,
  deleteManagedAttachment,
  deleteManagedAttachmentsForSession,
  getManagedAttachment,
  listManagedAttachments,
} from '../services/managedAttachmentStore.js'

const SAFE_INLINE_MIME_TYPES = new Set([
  'application/pdf',
  'audio/aac',
  'audio/flac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'image/gif',
  'image/avif',
  'image/bmp',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
  'text/csv',
  'text/markdown',
  'text/plain',
  'video/mp4',
  'video/ogg',
  'video/quicktime',
  'video/webm',
  'video/x-m4v',
  'video/x-matroska',
  'video/x-msvideo',
])

const ACTIVE_PREVIEW_MIME_TYPES = new Set([
  'application/xhtml+xml',
  'image/svg+xml',
  'text/html',
])

const ACTIVE_PREVIEW_CSP = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:"

function sendError(res, error) {
  return sendJson(res, error?.statusCode || 500, {
    error: {
      code: error?.code || 'ATTACHMENT_REQUEST_FAILED',
      message: error?.message || String(error),
    },
  })
}

function contentDisposition(name, inline = false) {
  const fallback = String(name || 'attachment')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/["\\\r\n]/g, '_')
    .slice(0, 120) || 'attachment'
  const mode = inline ? 'inline' : 'attachment'
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name || 'attachment')}`
}

function routeParts(pathname) {
  return pathname.split('/').filter(Boolean)
}

function parseRange(header, size) {
  const match = String(header || '').match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (!match[1] && !match[2])) return null
  let start = match[1] ? Number(match[1]) : null
  let end = match[2] ? Number(match[2]) : null
  if (start == null) {
    if (!Number.isSafeInteger(end) || end <= 0) return null
    start = Math.max(0, size - end)
    end = size - 1
  } else {
    end = end == null ? size - 1 : Math.min(end, size - 1)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || start >= size) return null
  return { start, end }
}

function attachmentPresentation(mimeType, preview) {
  const activePreview = preview && ACTIVE_PREVIEW_MIME_TYPES.has(mimeType)
  const inline = activePreview || SAFE_INLINE_MIME_TYPES.has(mimeType)
  return {
    activePreview,
    contentType: inline ? mimeType : 'application/octet-stream',
    inline,
  }
}

function attachmentSecurityHeaders({ activePreview, inline, mimeType, preview }) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    ...(activePreview ? { 'Content-Security-Policy': ACTIVE_PREVIEW_CSP } : {}),
    ...(!inline ? { 'Content-Security-Policy': "sandbox; default-src 'none'" } : {}),
    ...(preview && (activePreview || mimeType === 'application/pdf')
      ? { 'X-Frame-Options': 'SAMEORIGIN' }
      : {}),
  }
}

function openAttachmentContent(fullPath) {
  try {
    return fs.openSync(fullPath, 'r')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const missing = new Error('附件内容不存在', { cause: error })
    missing.statusCode = 410
    missing.code = 'ATTACHMENT_CONTENT_MISSING'
    throw missing
  }
}

function closeAttachmentContent(descriptor) {
  try { fs.closeSync(descriptor) } catch { /* best effort after a response failure */ }
}

function streamAttachment(res, fullPath, descriptor, range) {
  const stream = fs.createReadStream(fullPath, {
    ...(range || {}),
    fd: descriptor,
    autoClose: true,
  })
  stream.once('error', (error) => {
    if (!res.headersSent) return sendError(res, error)
    if (!res.destroyed) res.destroy(error)
  })
  stream.pipe(res)
  return stream
}

function authenticateAttachmentRequest(req, url, parts) {
  const contentRead = ['GET', 'HEAD'].includes(req.method)
    && parts.length === 4
    && parts[0] === 'api'
    && parts[1] === 'attachments'
    && parts[2]
    && parts[3] === 'content'

  // Embedded media and browser download links cannot attach an Authorization
  // header. Accept the session token from the query string only for the exact
  // read-only content endpoint; metadata and mutation routes stay header-only.
  const contentToken = contentRead ? url.searchParams.get('token') : ''
  if (contentToken && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${contentToken}`
  }
  return authenticateRequest(req)
}

export async function handleAttachmentRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const parts = routeParts(url.pathname)
  const userId = authenticateAttachmentRequest(req, url, parts)
  if (!userId) return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
  try {
    if (req.method === 'POST' && url.pathname === '/api/attachments/cleanup') {
      return sendJson(res, 200, cleanupManagedAttachments({ userId }))
    }

    if (req.method === 'POST' && url.pathname === '/api/attachments') {
      const name = url.searchParams.get('filename') || req.headers['x-gugo-filename']
      const mimeType = url.searchParams.get('mimeType') || req.headers['content-type']
      const sessionId = url.searchParams.get('sessionId') || req.headers['x-gugo-session-id'] || null
      const messageId = url.searchParams.get('messageId') || req.headers['x-gugo-message-id'] || null
      const attachment = await createManagedAttachment({
        userId,
        name,
        mimeType,
        sessionId,
        messageId,
        source: req,
        contentLength: req.headers['content-length'],
      })
      return sendJson(res, 201, { attachment: projectManagedAttachmentDto(attachment) })
    }

    if (req.method === 'GET' && url.pathname === '/api/attachments') {
      const attachments = listManagedAttachments({
        userId,
        sessionId: url.searchParams.get('sessionId'),
        messageId: url.searchParams.get('messageId'),
        limit: url.searchParams.get('limit'),
      })
      return sendJson(res, 200, { attachments: projectManagedAttachmentList(attachments) })
    }

    if (req.method === 'DELETE' && url.pathname === '/api/attachments') {
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) {
        return sendJson(res, 400, { error: { code: 'ATTACHMENT_SESSION_REQUIRED', message: 'sessionId is required' } })
      }
      const removed = deleteManagedAttachmentsForSession({ userId, sessionId })
      return sendJson(res, 200, { ok: true, removed })
    }

    if (parts[0] === 'api' && parts[1] === 'attachments' && parts[2]) {
      const id = decodeURIComponent(parts[2])
      const attachment = getManagedAttachment({ userId, id })
      if (!attachment) {
        return sendJson(res, 404, { error: { code: 'ATTACHMENT_NOT_FOUND', message: '附件不存在或无权访问' } })
      }
      if (req.method === 'GET' && parts.length === 3) {
        return sendJson(res, 200, { attachment: projectManagedAttachmentDto(attachment) })
      }
      if (['GET', 'HEAD'].includes(req.method) && parts.length === 4 && parts[3] === 'content') {
        const preview = url.searchParams.get('preview') === '1'
        const presentation = attachmentPresentation(attachment.mimeType, preview)
        const requestedRange = req.headers.range
        const range = requestedRange ? parseRange(requestedRange, attachment.size) : null
        const securityHeaders = attachmentSecurityHeaders({
          ...presentation,
          mimeType: attachment.mimeType,
          preview,
        })
        if (requestedRange && !range) {
          res.writeHead(416, {
            'Content-Range': `bytes */${attachment.size}`,
            'Accept-Ranges': 'bytes',
            ...securityHeaders,
          })
          return res.end()
        }
        const descriptor = openAttachmentContent(attachment.fullPath)
        let streamOwnsDescriptor = false
        try {
          res.writeHead(range ? 206 : 200, {
            'Content-Type': presentation.contentType,
            'Content-Length': String(range ? range.end - range.start + 1 : attachment.size),
            'Content-Disposition': contentDisposition(attachment.name, presentation.inline),
            'Cache-Control': 'private, max-age=31536000, immutable',
            'Accept-Ranges': 'bytes',
            ETag: `"sha256-${attachment.sha256}"`,
            ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${attachment.size}` } : {}),
            ...securityHeaders,
          })
          if (req.method === 'HEAD') return res.end()
          const stream = streamAttachment(res, attachment.fullPath, descriptor, range)
          streamOwnsDescriptor = true
          return stream
        } finally {
          if (!streamOwnsDescriptor) closeAttachmentContent(descriptor)
        }
      }
      if (req.method === 'DELETE' && parts.length === 3) {
        deleteManagedAttachment({ userId, id })
        return sendJson(res, 200, { ok: true })
      }
    }

    return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } })
  } catch (error) {
    return sendError(res, error)
  }
}
