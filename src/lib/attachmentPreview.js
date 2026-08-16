import { safeAttachmentName } from './attachmentClient.js'

export function buildAttachmentPreviewArtifact(attachment, { messageId = '' } = {}) {
  if (!attachment?.id) return null
  const filename = safeAttachmentName(attachment.name)
  const mimeType = String(attachment.mimeType || attachment.type || 'application/octet-stream')
  const url = String(attachment.downloadUrl || attachment.dataUrl || '')
  if (!url) return null
  return {
    messageId: String(messageId || ''),
    artifactIdentity: `attachment:${attachment.id}`,
    directFile: {
      id: String(attachment.id),
      filename,
      type: mimeType,
      mimeType,
      url,
      summary: mimeType,
    },
  }
}
