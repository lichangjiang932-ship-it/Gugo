import { resolveDeliveryArtifacts } from '../../../lib/artifactReferences.js'
import { buildAttachmentPreviewArtifact } from '../../../lib/attachmentPreview.js'
import {
  buildRetainedLocalFileReferences,
  buildVerifiedLocalFileReferences,
} from '../../../lib/localFileReferences.js'
import { verifiedLocalFileIdentity } from '../../../lib/verifiedLocalFileIdentity.js'

function collectAttachmentArtifacts(attachments, { messageId = '', current = false } = {}) {
  return (Array.isArray(attachments) ? attachments : [])
    .map((attachment) => buildAttachmentPreviewArtifact(attachment, { messageId }))
    .filter(Boolean)
    .map((artifact, index) => ({
      ...artifact.directFile,
      id: artifact.directFile.id || `${messageId || 'current'}-${index}-${artifact.directFile.url}`,
      messageId,
      userAttachment: true,
      currentAttachment: current,
    }))
}

export function collectArtifacts(messages, currentAttachments = []) {
  const messageArtifacts = messages.flatMap((message, index) => {
    if (message?.role === 'user') {
      return collectAttachmentArtifacts(message.attachments, { messageId: message.id || String(index) })
    }
    if (message?.role !== 'assistant') return []
    const suspended = message?.meta?.interrupted === true || message?.meta?.paused === true
    const canPresentLocalFiles = message?.meta?.streaming !== true
      || suspended
      || message?.meta?.failed === true
    if (!canPresentLocalFiles) return []
    const deliveryArtifacts = message?.meta?.failed || suspended || message?.meta?.streaming
      ? []
      : resolveDeliveryArtifacts(message?.meta)
    const verifiedLocalFiles = buildVerifiedLocalFileReferences({
      toolCalls: message?.meta?.toolCalls,
      verifiedLocalFiles: message?.meta?.verifiedLocalFiles,
      messageId: message?.id,
      turnId: message?.meta?.serverTurnId,
    }).map((reference) => ({
      ...(reference.previewArtifact?.directFile || {}),
      id: reference.id,
      messageId: message.id,
      verifiedLocalFile: true,
    }))
    const retainedLocalFiles = buildRetainedLocalFileReferences({
      toolCalls: message?.meta?.toolCalls,
      retainedLocalFiles: message?.meta?.retainedLocalFiles,
      messageId: message?.id,
      turnId: message?.meta?.serverTurnId,
    }).map((reference) => ({
      ...(reference.previewArtifact?.directFile || {}),
      id: reference.id,
      messageId: message.id,
      retainedLocalFile: true,
      verificationPending: true,
    }))
    const managedArtifacts = deliveryArtifacts
      .filter((artifact) => artifact?.url)
      .map((artifact) => ({
        ...artifact,
        id: artifact.id || `${message.id || index}-${artifact.url}`,
        messageId: message.id,
      }))
    return [...managedArtifacts, ...retainedLocalFiles, ...verifiedLocalFiles]
  }).reverse()
  const newestFirst = [
    ...collectAttachmentArtifacts(currentAttachments, { current: true }).reverse(),
    ...messageArtifacts,
  ]
  const seenLocalFiles = new Set()
  const seenAttachments = new Set()
  return newestFirst.filter((artifact) => {
    if (artifact?.userAttachment === true) {
      const identity = String(artifact.id || artifact.url || '')
      if (!identity || seenAttachments.has(identity)) return false
      seenAttachments.add(identity)
      return true
    }
    if (artifact?.verifiedLocalFile !== true && artifact?.retainedLocalFile !== true) return true
    const identity = verifiedLocalFileIdentity(artifact)
    if (!identity || seenLocalFiles.has(identity)) return !identity
    seenLocalFiles.add(identity)
    return true
  })
}
