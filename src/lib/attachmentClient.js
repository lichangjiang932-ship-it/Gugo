import { authHeaders } from './agentClient.js'

function responseError(payload, status) {
  const message = payload?.error?.message || payload?.error || `HTTP ${status}`
  const error = new Error(String(message))
  error.status = status
  error.code = payload?.error?.code || payload?.code
  return error
}

export function safeAttachmentName(value) {
  const sanitized = [...String(value || 'attachment')]
    .filter((character) => {
      const code = character.codePointAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
  const name = sanitized
    .split(/[\\/]/)
    .pop()
    .trim()
  return name || 'attachment'
}

export function serializeAttachmentReferences(attachments = []) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter((item) => item?.uploadStatus === 'ready' && item?.id)
    .map((item) => ({
      id: String(item.id),
      name: safeAttachmentName(item.name),
      mimeType: String(item.mimeType || item.type || 'application/octet-stream'),
      size: Math.max(0, Number(item.size) || Math.round((Number(item.sizeKB) || 0) * 1024)),
      sha256: String(item.sha256 || ''),
      downloadUrl: String(item.downloadUrl || ''),
    }))
}

export async function uploadChatAttachment(file, {
  sessionId,
  messageId,
  signal,
  fetchImpl = fetch,
} = {}) {
  if (!file || typeof file !== 'object') throw new TypeError('file is required')
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) throw new TypeError('sessionId is required')
  const name = safeAttachmentName(file.name)
  const mimeType = String(file.type || 'application/octet-stream')
  const query = new URLSearchParams({ filename: name, mimeType, sessionId: normalizedSessionId })
  if (messageId) query.set('messageId', String(messageId))
  const response = await fetchImpl(`/api/attachments?${query}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': mimeType },
    body: file,
    signal,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload?.attachment?.id) throw responseError(payload, response.status)
  const attachment = payload.attachment
  return {
    id: String(attachment.id),
    name: safeAttachmentName(attachment.name || name),
    mimeType: String(attachment.mimeType || mimeType),
    type: String(attachment.mimeType || mimeType),
    size: Math.max(0, Number(attachment.size) || Number(file.size) || 0),
    sizeKB: ((Math.max(0, Number(attachment.size) || Number(file.size) || 0)) / 1024).toFixed(1),
    sha256: String(attachment.sha256 || ''),
    status: String(attachment.status || 'ready'),
    sessionId: String(attachment.sessionId || normalizedSessionId),
    messageId: attachment.messageId ? String(attachment.messageId) : null,
    createdAt: attachment.createdAt,
    downloadUrl: String(attachment.downloadUrl || `/api/attachments/${encodeURIComponent(attachment.id)}/content`),
  }
}
