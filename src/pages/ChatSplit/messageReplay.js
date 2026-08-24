import { safeAttachmentName } from '../../lib/attachmentClient.js'

function readyAttachmentReference(value) {
  if (!value?.id) return null
  const mimeType = String(value.mimeType || value.type || 'application/octet-stream')
  const size = Math.max(0, Number(value.size) || 0)
  return {
    id: String(value.id),
    name: safeAttachmentName(value.name),
    mimeType,
    type: mimeType,
    size,
    sizeKB: (size / 1024).toFixed(1),
    sha256: String(value.sha256 || ''),
    downloadUrl: String(value.downloadUrl || ''),
    uploadStatus: 'ready',
  }
}

function messageIndex(history, anchorMessage) {
  return history.findIndex((message) => (
    message === anchorMessage
      || (anchorMessage?.id && message?.id === anchorMessage.id)
  ))
}

export function buildMessageReplayRequest(messages, anchorMessage) {
  const history = Array.isArray(messages) ? messages : []
  let userIndex = messageIndex(history, anchorMessage)
  if (userIndex < 0) return null
  if (history[userIndex]?.role !== 'user') {
    userIndex -= 1
    while (userIndex >= 0 && history[userIndex]?.role !== 'user') userIndex -= 1
  }
  if (userIndex < 0) return null

  const userMessage = history[userIndex]
  const content = String(userMessage?.content || '')
  const attachments = (Array.isArray(userMessage?.attachments) ? userMessage.attachments : [])
    .map(readyAttachmentReference)
    .filter(Boolean)
  if (!content.trim() && attachments.length === 0) return null
  return {
    content,
    attachments,
    historyLimit: userIndex,
    sourceMessageId: String(userMessage?.id || ''),
  }
}
