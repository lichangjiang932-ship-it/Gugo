import fs from 'node:fs'
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
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
])

function publicAttachment(attachment) {
  if (!attachment) return null
  const safe = { ...attachment }
  delete safe.fullPath
  return safe
}

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

function authenticateAttachmentRequest(req, url, parts) {
  const contentRead = req.method === 'GET'
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
      return sendJson(res, 201, { attachment: publicAttachment(attachment) })
    }

    if (req.method === 'GET' && url.pathname === '/api/attachments') {
      const attachments = listManagedAttachments({
        userId,
        sessionId: url.searchParams.get('sessionId'),
        messageId: url.searchParams.get('messageId'),
        limit: url.searchParams.get('limit'),
      })
      return sendJson(res, 200, { attachments })
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
        return sendJson(res, 200, { attachment: publicAttachment(attachment) })
      }
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'content') {
        const inline = SAFE_INLINE_MIME_TYPES.has(attachment.mimeType)
        res.writeHead(200, {
          'Content-Type': inline ? attachment.mimeType : 'application/octet-stream',
          'Content-Length': String(attachment.size),
          'Content-Disposition': contentDisposition(attachment.name, inline),
          'Cache-Control': 'private, max-age=31536000, immutable',
          ETag: `"sha256-${attachment.sha256}"`,
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Referrer-Policy': 'no-referrer',
          ...(!inline ? { 'Content-Security-Policy': "sandbox; default-src 'none'" } : {}),
        })
        return fs.createReadStream(attachment.fullPath).pipe(res)
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
