import { describeAttachmentPrompt } from '../../lib/attachments.js'
import { isLoggedInLocally } from '../../lib/accountClient.js'
import { parseSlashCommandInput } from '../../lib/slashCommandRegistry.js'
import { attachmentSendState } from '../../lib/chatAttachmentUpload.js'
import { applyAcceptedChatDraft } from './chatAcceptedDraft.js'
import { isChatCompositionEvent, shouldSubmitChatKey } from './chatComposerKeyGuard.js'

export function useChatSendActions({
  attachments,
  attachmentsRef,
  directoryApprovalOpen,
  dispatch,
  executeSlashEntry,
  input,
  inputRef,
  isGenerating,
  messageEdit,
  modelReadiness,
  navigateInputHistory,
  setAttachments,
  setInput,
  setMessageEdit,
  setWorkbenchMessage,
  showAuthenticationRequired,
  showModelUnavailable,
  showPendingDirectoryGuidance,
  slashRegistry,
  state,
  stateRef,
  steerActiveTurn,
  t,
  toast,
  triggerSendFlow,
}) {
  const handleWorkbenchSend = async (content) => {
    if (!isLoggedInLocally()) {
      showAuthenticationRequired()
      return false
    }
    if (!modelReadiness.canSend) {
      showModelUnavailable(modelReadiness)
      return false
    }
    return triggerSendFlow(content)
  }

  const handleSend = async () => {
    const typedContent = input.trim()
    if (!typedContent && attachments.length === 0) return
    if (!isLoggedInLocally()) {
      showAuthenticationRequired()
      return
    }
    if (showPendingDirectoryGuidance(typedContent)) return
    if (isGenerating) {
      if (!typedContent) {
        setWorkbenchMessage(t('chatSteering.textOnly'))
        return
      }
      await steerActiveTurn(typedContent)
      return
    }
    if (directoryApprovalOpen) return
    const attachmentState = attachmentSendState(attachments)
    if (attachmentState.uploading) {
      setWorkbenchMessage(t('chatAttachments.waitingForUploads'))
      return
    }
    if (attachmentState.failed) {
      setWorkbenchMessage(t('chatAttachments.removeFailed'))
      return
    }
    const parsedSlash = parseSlashCommandInput(typedContent)
    const slashEntry = parsedSlash ? slashRegistry.getCommand(parsedSlash.name) : null
    if (slashEntry && slashEntry.kind !== 'skill') {
      if (slashEntry.requiresModel && !modelReadiness.canSend) {
        showModelUnavailable(modelReadiness)
        return
      }
      setInput('')
      setMessageEdit(null)
      executeSlashEntry(slashEntry, parsedSlash.args)
      return
    }
    if (!modelReadiness.canSend) {
      showModelUnavailable(modelReadiness)
      return
    }
    const inputSnapshot = input
    const currentAttachments = [...attachments]
    const draftSessionId = state.activeSessionId
    const replayDraft = messageEdit?.sessionId === draftSessionId ? messageEdit : null
    if (replayDraft) {
      const truncated = await dispatch({
        type: 'TRUNCATE_MESSAGES',
        payload: replayDraft.historyLimit,
      })
      if (truncated === false) {
        toast.error({ title: t('toast.chatSendFailed'), body: t('errors.chatFailure') })
        return
      }
    }
    await triggerSendFlow(
      typedContent || describeAttachmentPrompt(currentAttachments),
      currentAttachments,
      replayDraft?.historyLimit ?? null,
      ({ sessionId: acceptedSessionId } = {}) => {
        if (replayDraft) setMessageEdit(null)
        applyAcceptedChatDraft({
          acceptedSessionId,
          activeSessionId: stateRef.current.activeSessionId,
          attachments: attachmentsRef.current,
          dispatch,
          draftSessionId,
          input: inputRef.current,
          inputSnapshot,
          sentAttachments: currentAttachments,
          setAttachments,
          setInput,
        })
      },
    )
  }

  const handleKeyDown = (event) => {
    if (isChatCompositionEvent(event)) return
    if (navigateInputHistory(event)) return
    if (shouldSubmitChatKey(event)) {
      event.preventDefault()
      handleSend()
    }
  }

  return { handleKeyDown, handleSend, handleWorkbenchSend }
}
