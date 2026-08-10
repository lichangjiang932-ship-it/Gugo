import { safeAttachmentName, uploadChatAttachment } from './attachmentClient.js'
import { parseChatAttachments } from './chatAttachmentParser.js'

function attachmentId(file) {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${safeAttachmentName(file?.name)}`
}

export function createPendingChatAttachment(file) {
  return {
    id: attachmentId(file),
    name: safeAttachmentName(file?.name),
    kind: 'file',
    type: String(file?.type || 'application/octet-stream'),
    mimeType: String(file?.type || 'application/octet-stream'),
    size: Math.max(0, Number(file?.size) || 0),
    sizeKB: (Math.max(0, Number(file?.size) || 0) / 1024).toFixed(1),
    uploadStatus: 'uploading',
  }
}

export async function prepareChatAttachment(file, pending, {
  sessionId,
  parserOptions,
  parseImpl = parseChatAttachments,
  uploadImpl = uploadChatAttachment,
} = {}) {
  const [preview, uploaded] = await Promise.allSettled([
    parseImpl([file], parserOptions).then((items) => items[0] || {}),
    uploadImpl(file, { sessionId }),
  ])
  if (uploaded.status === 'rejected') {
    return {
      ...pending,
      ...(preview.status === 'fulfilled' ? preview.value : {}),
      id: pending.id,
      name: pending.name,
      uploadStatus: 'error',
      uploadError: uploaded.reason?.message || String(uploaded.reason),
    }
  }
  return {
    ...pending,
    ...(preview.status === 'fulfilled' ? preview.value : {}),
    ...uploaded.value,
    id: uploaded.value.id,
    uploadStatus: 'ready',
    previewError: preview.status === 'rejected' ? preview.reason?.message || String(preview.reason) : undefined,
  }
}

export function attachmentSendState(attachments = []) {
  const items = Array.isArray(attachments) ? attachments : []
  return {
    uploading: items.some((item) => item?.uploadStatus === 'uploading'),
    failed: items.some((item) => item?.uploadStatus !== 'ready' || !item?.id),
  }
}
