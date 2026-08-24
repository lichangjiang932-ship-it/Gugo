import { fetchCompactionArchive } from '../../lib/compactionClient.js'
import { MAX_CHAT_ATTACHMENTS_PER_MESSAGE } from '../../lib/chatAttachmentParser.js'
import { createPendingChatAttachment, prepareChatAttachment } from '../../lib/chatAttachmentUpload.js'
import { createChatSessionId } from './chatSessionId.js'

export function useChatAttachmentActions({
  attachments,
  createPendingAttachment = createPendingChatAttachment,
  createSessionId = createChatSessionId,
  dispatch,
  prepareAttachment = prepareChatAttachment,
  preserveAttachmentsForSessionRef,
  setAttachments,
  setWorkbenchMessage,
  state,
  t,
}) {
  const handleFileChange = async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return
    const available = Math.max(0, MAX_CHAT_ATTACHMENTS_PER_MESSAGE - attachments.length)
    const accepted = files.slice(0, available)
    if (!accepted.length) {
      setWorkbenchMessage(t('chatAttachments.maxCountNotice', { count: files.length }))
      return
    }
    let targetSessionId = state.activeSessionId
    if (!targetSessionId) {
      targetSessionId = String(state.draftSessionId || '').trim() || createSessionId()
      preserveAttachmentsForSessionRef.current = targetSessionId
      if (targetSessionId !== state.draftSessionId) {
        dispatch({ type: 'SET_DRAFT_SESSION_ID', payload: { sessionId: targetSessionId } })
      }
    }
    const pending = accepted.map(createPendingAttachment)
    setAttachments((current) => [...current, ...pending].slice(0, MAX_CHAT_ATTACHMENTS_PER_MESSAGE))
    setWorkbenchMessage(t('chatAttachments.uploading'))
    const parserMessages = Object.fromEntries([
      'imageLimit',
      'imageTooLarge',
      'compressedTooLarge',
      'excelTooLong',
      'wordTooLong',
      'pptTooLong',
      'textTooLong',
      'unsupportedFormat',
      'readFailed',
    ].map((key) => [key, t(`chatAttachments.${key}`)]))
    const existingImageCount = attachments.filter((item) => item.kind === 'image').length
    const prepared = await Promise.all(accepted.map(async (file, index) => ({
      pendingId: pending[index].id,
      result: await prepareAttachment(file, pending[index], {
        sessionId: targetSessionId,
        parserOptions: {
          existingImageCount: existingImageCount + accepted.slice(0, index)
            .filter((item) => item.type.startsWith('image/')).length,
          messages: parserMessages,
        },
      }),
    })))
    const byPendingId = new Map(prepared.map((item) => [item.pendingId, item.result]))
    setAttachments((current) => current.map((item) => byPendingId.get(item.id) || item))
    const failed = prepared.filter((item) => item.result.uploadStatus === 'error').length
    if (failed) setWorkbenchMessage(t('chatAttachments.uploadFailedCount', { count: failed }))
    else if (files.length > accepted.length) {
      setWorkbenchMessage(t('chatAttachments.maxCountNotice', { count: files.length - accepted.length }))
    } else setWorkbenchMessage(t('chatAttachments.addedNotice', { count: prepared.length }))
  }

  const handleExpandCompaction = async (archiveId) => {
    if (!archiveId) return
    try {
      const archive = await fetchCompactionArchive(archiveId)
      dispatch({
        type: 'EXPAND_COMPACTED',
        payload: {
          sessionId: state.activeSessionId,
          archiveId,
          archivedMessages: archive.archivedMessages || [],
        },
      })
      setWorkbenchMessage(`Restored ${archive.replacedMessageCount || 0} archived messages.`)
    } catch (error) {
      setWorkbenchMessage(error.message || 'Failed to restore compacted context.')
    }
  }

  return { handleExpandCompaction, handleFileChange }
}
