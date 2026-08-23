import { safeAttachmentName } from '../../lib/attachmentClient.js'
import { isModelPreExecutionFailure } from '../../lib/chatFlowGuards.js'

function readyAttachmentReference(value) {
  if (!value?.id) return null
  const mimeType = String(value.mimeType || value.type || 'application/octet-stream')
  return {
    id: String(value.id),
    name: safeAttachmentName(value.name),
    mimeType,
    type: mimeType,
    size: Math.max(0, Number(value.size) || 0),
    sizeKB: (Math.max(0, Number(value.size) || 0) / 1024).toFixed(1),
    sha256: String(value.sha256 || ''),
    downloadUrl: String(value.downloadUrl || ''),
    uploadStatus: 'ready',
  }
}

export function buildModelFailureRetryRequest(messages, failedMessage) {
  const history = Array.isArray(messages) ? messages : []
  if (!isModelPreExecutionFailure(failedMessage)) return null
  const failedIndex = history.findIndex((message) => (
    message === failedMessage
      || (failedMessage?.id && message?.id === failedMessage.id)
  ))
  if (failedIndex < 0) return null

  let userIndex = failedIndex - 1
  while (userIndex >= 0 && history[userIndex]?.role !== 'user') userIndex -= 1
  if (userIndex < 0) return null

  const userMessage = history[userIndex]
  const content = String(userMessage?.content || '')
  const attachments = (Array.isArray(userMessage?.attachments) ? userMessage.attachments : [])
    .map(readyAttachmentReference)
    .filter(Boolean)
  if (!content.trim() && attachments.length === 0) return null
  return { content, attachments, historyLimit: userIndex }
}
