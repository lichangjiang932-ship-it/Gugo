import { safeAttachmentName } from './attachmentClient.js'

export function normalizeDraftAttachments(values = []) {
  const seen = new Set()
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const id = String(value?.id || '').trim()
    if (!id || value?.uploadStatus !== 'ready' || seen.has(id)) return []
    seen.add(id)
    const mimeType = String(value?.mimeType || value?.type || 'application/octet-stream')
    const size = Math.max(0, Number(value?.size) || 0)
    return [{
      id,
      name: safeAttachmentName(value?.name),
      kind: String(value?.kind || (mimeType.startsWith('image/') ? 'image' : 'file')),
      type: mimeType,
      mimeType,
      size,
      sizeKB: (size / 1024).toFixed(1),
      uploadStatus: 'ready',
      sha256: String(value?.sha256 || ''),
      downloadUrl: String(value?.downloadUrl || ''),
      ...(value?.sessionId ? { sessionId: String(value.sessionId) } : {}),
      ...(value?.messageId ? { messageId: String(value.messageId) } : {}),
    }]
  })
}

export function readSessionDraft(value) {
  if (typeof value === 'string') return { text: value, attachments: [] }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { text: '', attachments: [] }
  return {
    text: typeof value.text === 'string' ? value.text : '',
    attachments: normalizeDraftAttachments(value.attachments),
  }
}

export function writeSessionDraft(current, patch = {}) {
  const previous = readSessionDraft(current)
  const text = Object.hasOwn(patch, 'text') ? String(patch.text ?? '') : previous.text
  const attachments = Object.hasOwn(patch, 'attachments')
    ? normalizeDraftAttachments(patch.attachments)
    : previous.attachments
  if (!text && attachments.length === 0) return null
  // Preserve the compact legacy representation for text-only drafts.
  return attachments.length === 0 ? text : { text, attachments }
}
